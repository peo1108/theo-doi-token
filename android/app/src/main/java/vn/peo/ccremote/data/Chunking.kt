package vn.peo.ccremote.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

/**
 * Khung nhị phân "part" cho tin lớn, khớp hub/proto.js:
 * [4 byte độ dài phần đầu, big-endian][phần đầu JSON {type:'part', pid, idx, last, machine?|conn?}][dữ liệu].
 */
object Chunking {
    /** tin JSON lớn hơn mức này (tính theo byte UTF-8) thì chia, mỗi mảnh tối đa CHUNK byte dữ liệu */
    const val CHUNK = 256 * 1024
    const val MAX_MSG = 50 * 1024 * 1024
    const val MAX_HEADER = 4096
    const val PART_IDLE_MS = 60_000L

    class Part(val header: JsonObject, val pid: String, val idx: Int, val last: Boolean, val payload: ByteArray)

    fun encodePart(header: JsonObject, payload: ByteArray): ByteArray {
        val h = Json.encodeToString(JsonObject.serializer(), header).toByteArray(Charsets.UTF_8)
        val out = ByteArray(4 + h.size + payload.size)
        out[0] = (h.size ushr 24).toByte()
        out[1] = (h.size ushr 16).toByte()
        out[2] = (h.size ushr 8).toByte()
        out[3] = h.size.toByte()
        System.arraycopy(h, 0, out, 4, h.size)
        System.arraycopy(payload, 0, out, 4 + h.size, payload.size)
        return out
    }

    /** null nếu khung hỏng (hub cũng chỉ bỏ qua). */
    fun decodePart(buf: ByteArray): Part? {
        if (buf.size < 4) return null
        val n = (buf[0].toInt() and 0xff shl 24) or (buf[1].toInt() and 0xff shl 16) or (buf[2].toInt() and 0xff shl 8) or (buf[3].toInt() and 0xff)
        if (n < 0 || n > MAX_HEADER || 4 + n > buf.size) return null
        val header = try {
            Json.parseToJsonElement(String(buf, 4, n, Charsets.UTF_8)).jsonObject
        } catch (_: Exception) {
            return null
        }
        val pid = header["pid"]?.jsonPrimitive?.contentOrNull ?: return null
        val idx = header["idx"]?.jsonPrimitive?.intOrNull ?: return null
        val last = header["last"]?.jsonPrimitive?.booleanOrNull == true
        return Part(header, pid, idx, last, buf.copyOfRange(4 + n, buf.size))
    }

    /**
     * Tin nhỏ (≤ CHUNK byte) -> null: gửi như một khung chữ bình thường.
     * Tin lớn -> danh sách khung nhị phân; `machine` nằm ở phần đầu của mọi mảnh để hub định tuyến không cần ghép.
     */
    fun split(obj: JsonObject, chunk: Int = CHUNK): List<ByteArray>? {
        val data = Json.encodeToString(JsonObject.serializer(), obj).toByteArray(Charsets.UTF_8)
        if (data.size <= chunk) return null
        if (data.size > MAX_MSG) throw ApiError("TOO_LARGE", "Tin nhắn quá lớn (tối đa 50 MB)")
        val pid = (obj["id"] as? JsonPrimitive)?.contentOrNull ?: UUID.randomUUID().toString()
        val out = ArrayList<ByteArray>()
        var off = 0
        var idx = 0
        while (off < data.size) {
            val end = minOf(off + chunk, data.size)
            val header = JsonObject(buildMap<String, JsonElement> {
                put("type", JsonPrimitive("part"))
                put("pid", JsonPrimitive(pid))
                put("idx", JsonPrimitive(idx))
                put("last", JsonPrimitive(end == data.size))
                obj["machine"]?.let { put("machine", it) }
            })
            out.add(encodePart(header, data.copyOfRange(off, end)))
            off = end
            idx++
        }
        return out
    }
}

/** Ghép mảnh theo pid (phía nhận). Mảnh lệch thứ tự hoặc quá 50 MB thì bỏ cả tin; im quá 60 giây cũng bỏ. */
class Assembler {
    private class Pending(var next: Int = 0, var at: Long = 0, val data: java.io.ByteArrayOutputStream = java.io.ByteArrayOutputStream())

    private val m = HashMap<String, Pending>()

    val pendingCount: Int get() = m.size

    /** Trả tin đã ghép (JSON) khi nhận mảnh cuối; null khi chưa đủ hoặc mảnh bị bỏ. */
    fun push(p: Chunking.Part, now: Long = System.currentTimeMillis()): JsonObject? {
        sweep(now)
        val cur = m[p.pid] ?: Pending().also { m[p.pid] = it }
        if (p.idx != cur.next) {
            m.remove(p.pid)
            return null
        }
        cur.data.write(p.payload)
        cur.next++
        cur.at = now
        if (cur.data.size() > Chunking.MAX_MSG) {
            m.remove(p.pid)
            return null
        }
        if (!p.last) return null
        m.remove(p.pid)
        return try {
            val msg = Json.parseToJsonElement(cur.data.toByteArray().toString(Charsets.UTF_8)).jsonObject
            // hub gắn `machine` vào phần đầu mảnh của tin từ agent
            val machine = p.header["machine"]
            if (machine != null && msg["machine"] == null) JsonObject(msg + ("machine" to machine)) else msg
        } catch (_: Exception) {
            null
        }
    }

    fun sweep(now: Long = System.currentTimeMillis()) {
        m.entries.removeAll { now - it.value.at > Chunking.PART_IDLE_MS && it.value.at != 0L }
    }

    fun clear() = m.clear()
}

/** Thời gian chờ nối lại: 1 → 2 → 4 … tối đa 30 giây, nhiễu ngẫu nhiên ±20% (`rnd` trong [0,1)). */
fun backoffDelay(attempt: Int, rnd: Double): Double =
    minOf(30.0, Math.pow(2.0, attempt.coerceAtMost(10).toDouble())) * (0.8 + 0.4 * rnd)
