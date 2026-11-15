package vn.peo.ccremote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import vn.peo.ccremote.data.ApiError
import vn.peo.ccremote.data.Assembler
import vn.peo.ccremote.data.Chunking
import vn.peo.ccremote.data.backoffDelay
import vn.peo.ccremote.data.jsonOf

class ChunkingTest {
    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    /** Độ dài JSON (byte UTF-8) của {"p":"<n ký tự>"} để dựng tin có kích thước chính xác. */
    private fun msgOfSize(total: Int): JsonObject {
        val overhead = Json.encodeToString(JsonObject.serializer(), jsonOf("p" to "")).toByteArray().size
        return jsonOf("p" to "x".repeat(total - overhead))
    }

    private fun size(o: JsonObject) = Json.encodeToString(JsonObject.serializer(), o).toByteArray().size

    @Test fun `khung do hub proto js tao ra giai ma dung`() {
        // tạo bằng: encodePart({type:'part',pid:'abc123',idx:2,last:true,conn:'c9'}, Buffer.from('{"type":"res","id":"r1","ok":true}'))
        val frame = hex(
            "0000003e7b2274797065223a2270617274222c22706964223a22616263313233222c22696478223a322c226c617374223a747275652c22636f6e6e223a226339227d" +
                "7b2274797065223a22726573222c226964223a227231222c226f6b223a747275657d",
        )
        val p = Chunking.decodePart(frame)!!
        assertEquals("abc123", p.pid)
        assertEquals(2, p.idx)
        assertTrue(p.last)
        assertEquals("c9", p.header["conn"]!!.jsonPrimitive.content)
        assertEquals("""{"type":"res","id":"r1","ok":true}""", String(p.payload))
    }

    @Test fun `encodePart roi decodePart cho lai dung du lieu`() {
        val payload = ByteArray(1000) { (it % 251).toByte() }
        val enc = Chunking.encodePart(jsonOf("type" to "part", "pid" to "p", "idx" to 0, "last" to true), payload)
        val p = Chunking.decodePart(enc)!!
        assertArrayEquals(payload, p.payload)
        // 4 byte độ dài big-endian
        val n = (enc[0].toInt() and 0xff shl 24) or (enc[1].toInt() and 0xff shl 16) or (enc[2].toInt() and 0xff shl 8) or (enc[3].toInt() and 0xff)
        assertEquals(enc.size - 4 - payload.size, n)
    }

    @Test fun `khung hong bi bo qua`() {
        assertNull(Chunking.decodePart(ByteArray(2)))
        assertNull(Chunking.decodePart(byteArrayOf(0, 0, 0x10, 0, 1, 2, 3)))            // phần đầu > 4096
        assertNull(Chunking.decodePart(byteArrayOf(0, 0, 0, 5, '{'.code.toByte())))     // phần đầu dài hơn khung
        assertNull(Chunking.decodePart(Chunking.encodePart(jsonOf("type" to "part"), ByteArray(0))))   // thiếu pid / idx
    }

    @Test fun `tin dung bang 256KB khong chia, hon 1 byte thi chia dung ranh gioi`() {
        val exact = msgOfSize(Chunking.CHUNK)
        assertEquals(Chunking.CHUNK, size(exact))
        assertNull(Chunking.split(exact))

        val over = msgOfSize(Chunking.CHUNK + 1)
        val parts = Chunking.split(over)!!
        assertEquals(2, parts.size)
        val p0 = Chunking.decodePart(parts[0])!!
        val p1 = Chunking.decodePart(parts[1])!!
        assertEquals(Chunking.CHUNK, p0.payload.size)
        assertEquals(1, p1.payload.size)
        assertEquals(0, p0.idx); assertEquals(1, p1.idx)
        assertFalse(p0.last); assertTrue(p1.last)
        assertEquals(p0.pid, p1.pid)
    }

    @Test fun `tin hai mảnh tron va le ranh gioi`() {
        for (extra in listOf(Chunking.CHUNK, Chunking.CHUNK * 2 - 1, Chunking.CHUNK * 2, Chunking.CHUNK * 3 + 17)) {
            val obj = msgOfSize(extra + 1)
            val parts = Chunking.split(obj)!!
            val asm = Assembler()
            var out: JsonObject? = null
            parts.forEachIndexed { i, f ->
                val part = Chunking.decodePart(f)!!
                assertTrue("mảnh ${part.idx} không vượt CHUNK", part.payload.size <= Chunking.CHUNK)
                val r = asm.push(part)
                if (i < parts.size - 1) assertNull(r) else out = r
            }
            assertEquals(obj, out)
            assertEquals(0, asm.pendingCount)
        }
    }

    @Test fun `machine nam o phan dau moi manh va pid la id yeu cau`() {
        val obj = jsonOf("type" to "req", "id" to "req-42", "machine" to "m-1", "method" to "sessions.send", "params" to jsonOf("text" to "y".repeat(Chunking.CHUNK * 2)))
        val parts = Chunking.split(obj)!!
        assertEquals(3, parts.size)
        for (f in parts) {
            val p = Chunking.decodePart(f)!!
            assertEquals("req-42", p.pid)
            assertEquals("m-1", p.header["machine"]!!.jsonPrimitive.content)
        }
    }

    @Test fun `tieng Viet bi cat giua ky tu van ghep lai dung`() {
        val text = "Tiếng Việt có dấu ạ ặ ữ ợ ".repeat(40_000)
        val obj = jsonOf("id" to "v", "machine" to "m", "t" to text)
        val parts = Chunking.split(obj)!!
        assertTrue(parts.size >= 2)
        val asm = Assembler()
        var out: JsonObject? = null
        for (f in parts) out = asm.push(Chunking.decodePart(f)!!) ?: out
        assertEquals(text, out!!["t"]!!.jsonPrimitive.content)
    }

    @Test fun `tin qua 50MB bi tu choi`() {
        try {
            Chunking.split(jsonOf("big" to "z".repeat(Chunking.MAX_MSG + 10)))
            fail("phải ném TOO_LARGE")
        } catch (e: ApiError) {
            assertEquals("TOO_LARGE", e.code)
        }
    }

    @Test fun `ghep - manh lech thu tu thi bo ca tin`() {
        val obj = msgOfSize(Chunking.CHUNK * 3 + 1)
        val parts = Chunking.split(obj)!!.map { Chunking.decodePart(it)!! }
        val asm = Assembler()
        assertNull(asm.push(parts[0]))
        assertNull(asm.push(parts[2]))        // thiếu mảnh 1
        assertEquals(0, asm.pendingCount)     // đã bỏ
        assertNull(asm.push(parts[3]))        // mảnh sau khi bỏ: idx != 0 -> không nhận
    }

    @Test fun `ghep - nhieu pid xen ke va gan machine tu phan dau`() {
        val a = jsonOf("id" to "A", "v" to "a".repeat(Chunking.CHUNK + 5))
        val b = jsonOf("id" to "B", "v" to "b".repeat(Chunking.CHUNK + 5))
        val pa = Chunking.split(a)!!.map { Chunking.decodePart(it)!! }
        val pb = Chunking.split(b)!!.map { Chunking.decodePart(it)!! }
        // tin từ agent: hub gắn machine vào phần đầu
        fun withMachine(p: Chunking.Part) = Chunking.Part(JsonObject(p.header + ("machine" to JsonPrimitive("mach"))), p.pid, p.idx, p.last, p.payload)
        val asm = Assembler()
        assertNull(asm.push(withMachine(pa[0])))
        assertNull(asm.push(withMachine(pb[0])))
        val ra = asm.push(withMachine(pa[1]))!!
        val rb = asm.push(withMachine(pb[1]))!!
        assertEquals("A", ra["id"]!!.jsonPrimitive.content)
        assertEquals("B", rb["id"]!!.jsonPrimitive.content)
        assertEquals("mach", ra["machine"]!!.jsonPrimitive.content)
    }

    @Test fun `ghep - mach dở im qua 60 giay thi bi don`() {
        val obj = msgOfSize(Chunking.CHUNK * 2)
        val parts = Chunking.split(obj)!!.map { Chunking.decodePart(it)!! }
        val asm = Assembler()
        asm.push(parts[0], now = 1_000)
        assertEquals(1, asm.pendingCount)
        asm.sweep(now = 1_000 + Chunking.PART_IDLE_MS + 1)
        assertEquals(0, asm.pendingCount)
        // mảnh sau sweep: bị coi là tin mới không có idx 0 -> bỏ
        assertNull(asm.push(parts[1], now = 70_000))
    }

    @Test fun `tin nho khong bi chia`() {
        assertNull(Chunking.split(jsonOf("type" to "presence", "foreground" to true)))
        assertNotNull(Chunking.split(msgOfSize(Chunking.CHUNK + 100)))
    }

    @Test fun `backoff 1 2 4 den toi da 30 giay co nhieu`() {
        for (r in listOf(0.0, 0.5, 0.999)) {
            val f = 0.8 + 0.4 * r
            assertEquals(1.0 * f, backoffDelay(0, r), 1e-9)
            assertEquals(2.0 * f, backoffDelay(1, r), 1e-9)
            assertEquals(4.0 * f, backoffDelay(2, r), 1e-9)
            assertEquals(16.0 * f, backoffDelay(4, r), 1e-9)
            assertEquals(30.0 * f, backoffDelay(5, r), 1e-9)
            assertEquals(30.0 * f, backoffDelay(50, r), 1e-9)
        }
        assertTrue(backoffDelay(0, 0.0) >= 0.8 && backoffDelay(0, 0.9999) <= 1.2)
        assertTrue(backoffDelay(9, 0.9999) <= 36.0)
    }

    @Test fun `jsonOf dung kieu`() {
        val o = jsonOf("a" to 1, "b" to true, "c" to "s", "d" to listOf(1, 2), "e" to mapOf("k" to "v"), "f" to null)
        assertEquals(1, o["a"]!!.jsonPrimitive.int)
        assertTrue(o["b"]!!.jsonPrimitive.boolean)
        assertEquals("v", o["e"]!!.jsonObject["k"]!!.jsonPrimitive.content)
    }
}
