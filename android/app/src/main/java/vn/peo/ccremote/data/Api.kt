package vn.peo.ccremote.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/** "hub.vidu.com" -> "https://hub.vidu.com", bỏ dấu / cuối. */
fun normalizeHubUrl(raw: String): String {
    var s = raw.trim()
    val l = s.lowercase()
    if (s.isNotEmpty() && !l.startsWith("http://") && !l.startsWith("https://")) s = "https://$s"
    return s.trimEnd('/')
}

/** HTTP tới hub (chỉ đăng nhập / đăng xuất). Còn lại đi qua WebSocket. (= phần không-hub của APIClient.swift) */
class HubHttp(private val http: OkHttpClient) {
    suspend inline fun <reified T> post(base: String, path: String, body: JsonObject? = null, token: String? = null): T {
        val el = postRaw(base, path, body, token)
        return try {
            AppJson.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), el)
        } catch (_: Exception) {
            throw ApiError("DECODE", "Dữ liệu từ máy tính không đọc được — cập nhật tool trên máy tính?")
        }
    }

    suspend fun postRaw(base: String, path: String, body: JsonObject? = null, token: String? = null): JsonElement =
        withContext(Dispatchers.IO) {
            val req = try {
                Request.Builder().url(base + path)
                    .apply { if (token != null) header("Authorization", "Bearer $token") }
                    .post((body?.toString() ?: "{}").toRequestBody("application/json".toMediaType()))
                    .build()
            } catch (_: IllegalArgumentException) {
                throw ApiError("URL", "Địa chỉ máy tính không hợp lệ")
            }
            try {
                http.newCall(req).execute().use { resp ->
                    val text = resp.body.string()
                    if (!resp.isSuccessful) {
                        val j = try { AppJson.parseToJsonElement(text).jsonObject } catch (_: Exception) { null }
                        val code = j?.get("error")?.jsonPrimitive?.contentOrNull
                        val msg = j?.get("message")?.jsonPrimitive?.contentOrNull
                        if (code != null && msg != null) throw ApiError(code, msg)
                        throw ApiError("HTTP_${resp.code}", "Máy tính trả lỗi ${resp.code}")
                    }
                    try {
                        AppJson.parseToJsonElement(text)
                    } catch (_: Exception) {
                        throw ApiError("DECODE", "Dữ liệu từ máy tính không đọc được — cập nhật tool trên máy tính?")
                    }
                }
            } catch (e: IOException) {
                throw ApiError("NETWORK", describe(e))
            }
        }

    companion object {
        fun describe(e: IOException): String = when {
            e is UnknownHostException -> "Không tìm thấy hub — kiểm tra địa chỉ hub và mạng"
            e is ConnectException -> "Không kết nối được hub"
            e is SocketTimeoutException -> "Hết thời gian chờ máy tính phản hồi"
            e is SSLException -> "Lỗi HTTPS khi kết nối hub"
            e.message?.contains("CLEARTEXT", ignoreCase = true) == true -> "Bản này chỉ kết nối hub qua HTTPS"
            e.message?.contains("Unable to resolve host", ignoreCase = true) == true -> "Không tìm thấy hub — kiểm tra địa chỉ hub và mạng"
            e.message?.contains("Network is unreachable", ignoreCase = true) == true -> "Điện thoại đang không có mạng"
            else -> e.message ?: "Lỗi mạng"
        }
    }
}

/**
 * Gọi hàm trên máy tính qua hub (method của giao thức hub, không còn đường dẫn REST).
 * (= APIClient.swift, đã bỏ bước đổi đường dẫn HTTP cũ -> hàm)
 */
class ApiClient(val hub: HubClient, val machine: String) {
    suspend inline fun <reified T> call(method: String, params: JsonObject = JsonObject(emptyMap())): T {
        val el = hub.call(machine, method, params)
        return try {
            AppJson.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), el)
        } catch (_: Exception) {
            throw ApiError("DECODE", "Dữ liệu từ máy tính không đọc được — cập nhật tracker trên máy tính?")
        }
    }

    /** Theo dõi một phiên qua hub: phát lại sự kiện sau `after` rồi đẩy sự kiện mới. */
    fun events(session: String, after: Int, epoch: String): Flow<JsonObject> = hub.subscribe(machine, session, after, epoch)
}
