package vn.peo.ccremote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import vn.peo.ccremote.data.AppJson
import vn.peo.ccremote.data.Capabilities
import vn.peo.ccremote.data.Event
import vn.peo.ccremote.data.EventHead
import vn.peo.ccremote.data.HubLoginResponse
import vn.peo.ccremote.data.RemoteState
import vn.peo.ccremote.data.SessionSummary
import vn.peo.ccremote.data.normalizeHubUrl
import vn.peo.ccremote.data.relativeTime
import vn.peo.ccremote.data.statusInfo

/** Giải mã đủ các `kind` của Event mà ios/CCRemote/Models.swift có (dạng JSON lấy từ remote.js). */
class ModelsTest {
    private fun ev(json: String) = AppJson.decodeFromString<Event>(json)

    @Test fun `user co anh va via phone`() {
        val e = ev("""{"seq":3,"t":1731700000000,"kind":"user","text":"xem ảnh","via":"phone","images":[{"name":"u-1.jpg","thumb":"AAAA"},{"name":"u-2.jpg"}]}""")
        assertEquals("user", e.kind)
        assertEquals(3, e.seq)
        assertEquals("phone", e.via)
        assertEquals(2, e.images!!.size)
        assertEquals("AAAA", e.images!![0].thumb)
        assertNull(e.images!![1].thumb)
    }

    @Test fun `assistant va note va error`() {
        assertEquals("**đậm**", ev("""{"seq":1,"kind":"assistant","text":"**đậm**"}""").text)
        assertEquals("Đã ngắt", ev("""{"seq":2,"kind":"note","text":"Đã ngắt"}""").text)
        assertEquals("Lỗi", ev("""{"seq":3,"kind":"error","text":"Lỗi"}""").text)
    }

    @Test fun `tool voi id old new code path title`() {
        val e = ev(
            """{"seq":4,"kind":"tool","id":"toolu_1","name":"Edit","summary":"remote.js","input":"{}","path":"C:\\x\\remote.js","title":"Sửa",
               "code":"ls","old":"a","new":"b\nc"}""",
        )
        assertEquals("toolu_1", e.toolId)
        assertEquals("Edit", e.name)
        assertEquals("C:\\x\\remote.js", e.path)
        assertEquals("a", e.oldText)
        assertEquals("b\nc", e.newText)
        assertEquals("ls", e.code)
    }

    @Test fun `tool_result co loi va anh`() {
        val e = ev("""{"seq":5,"kind":"tool_result","id":"toolu_1","error":true,"text":"boom","images":[{"name":"c-abc.png"}]}""")
        assertEquals("toolu_1", e.toolId)
        assertEquals(true, e.error)
        assertEquals("c-abc.png", e.images!![0].name)
    }

    @Test fun `permission cau hoi va ke hoach`() {
        val q = ev(
            """{"seq":6,"kind":"permission","requestId":"req-1","tool":"AskUserQuestion","summary":"Màu gì?","input":"{}","canAlways":true,"toolUseId":"tu-1","reason":"",
               "questions":[{"question":"Màu gì?","header":"Màu","multiSelect":false,"options":[{"label":"Đỏ","description":""},{"label":"Xanh","description":"mát"}]}]}""",
        )
        assertEquals("req-1", q.requestId)
        assertEquals("tu-1", q.toolUseId)
        assertEquals(true, q.canAlways)
        assertEquals(2, q.questions!![0].options.size)
        assertEquals("mát", q.questions!![0].options[1].description)
        val p = ev("""{"seq":7,"kind":"permission","requestId":"req-2","tool":"ExitPlanMode","plan":"# Kế hoạch\n- a"}""")
        assertTrue(p.plan!!.startsWith("# Kế hoạch"))
    }

    @Test fun `decided co cau tra loi va loi nhan`() {
        val d = ev("""{"seq":8,"kind":"decided","requestId":"req-1","decision":"deny","text":"làm khác đi","answers":{"Màu gì?":"Đỏ"}}""")
        assertEquals("deny", d.decision)
        assertEquals("làm khác đi", d.text)
        assertEquals("req-1", d.requestId)
    }

    @Test fun `result limit thought output`() {
        val r = ev("""{"seq":9,"kind":"result","ok":true,"aborted":false,"cost":0.0123,"ms":5400,"turns":2,"text":""}""")
        assertEquals(true, r.ok)
        assertEquals(0.0123, r.cost!!, 1e-9)
        assertEquals(5400.0, r.ms!!, 1e-9)
        val l = ev("""{"seq":10,"kind":"limit","text":"Hết hạn mức","suggest":{"id":"a2","name":"Tài khoản phụ"}}""")
        assertEquals("a2", l.suggest!!.id)
        val t = ev("""{"seq":11,"kind":"thought","seconds":7,"tokens":1200}""")
        assertEquals(7.0, t.seconds!!, 1e-9)
        assertEquals(1200, t.tokens)
        val o = ev("""{"seq":12,"kind":"output","error":false,"text":"Context: 12K"}""")
        assertEquals("output", o.kind)
    }

    @Test fun `truong la va null khong lam vo giai ma`() {
        val e = ev("""{"seq":1,"kind":"assistant","text":null,"future":{"x":1},"t":null}""")
        assertNull(e.text)
        assertNull(e.t)
    }

    @Test fun `EventHead doc kind va epoch cua reset`() {
        val h = AppJson.decodeFromString<EventHead>("""{"kind":"reset","epoch":"e9"}""")
        assertEquals("reset", h.kind)
        assertEquals("e9", h.epoch)
        assertEquals("state", AppJson.decodeFromString<EventHead>("""{"kind":"state","id":"x"}""").kind)
    }

    @Test fun `state cua phien (SessionSummary) day du`() {
        val s = AppJson.decodeFromString<SessionSummary>(
            """{"kind":"state","settings":{"model":null,"modelValue":"default","modelLabel":"Opus 5.5","effort":"high","thinking":true,"flagSwitch":true,"fast":false,"outputStyle":"default"},
               "account":"a@b.c","external":true,"source":"VS Code","attached":true,"ready":false,"pcAway":false,"mirror":true,
               "id":"11111111-2222-3333-4444-555555555555","cwd":"C:\\x\\du-an","project":"du-an","title":"T","status":"waiting","live":true,"pending":1,"mode":"default",
               "model":null,"rate":{"status":"rejected","fiveHour":92.4,"sevenDay":10},"cost":1.5,"lastText":"xong","updatedAt":1731700000000,"epoch":"ab12","lastSeq":42,"watching":1,
               "thinking":{"tokens":300,"since":1731700000000},"ask":{"tool":"Write","summary":"a.txt"}}""",
        )
        assertEquals("waiting", s.status)
        assertEquals(1, s.pending)
        assertEquals("Write", s.ask!!.tool)
        assertEquals("rejected", s.rate!!.status)
        assertEquals(92.4, s.rate!!.fiveHour!!, 1e-9)
        assertEquals("high", s.settings!!.effort)
        assertEquals(42, s.lastSeq)
        assertEquals(300, s.thinking!!.tokens)
        assertNull(s.model)
    }

    @Test fun `RemoteState co tai khoan, du an, canh bao`() {
        val st = AppJson.decodeFromString<RemoteState>(
            """{"version":1,"host":"PC","now":1731700000000,"live":[],"recent":[{"id":"r1","cwd":"C:\\x","project":"x","title":"hi","updatedAt":1}],
               "projects":[{"cwd":"C:\\x","name":"x","lastUsed":1,"count":3,"lastTitle":"hi","live":1}],
               "accounts":{"active":"a1","conflict":false,"list":[{"id":"a1","name":"Chính","email":"c@e.com","plan":"max","active":true,"suggested":false,"loginState":"soon","stale":false,"error":null,
                 "fiveHour":{"pct":92,"resetsAt":1731703600000},"sevenDay":{"pct":41},"costToday":0.5}]},
               "alwaysOn":true,"pcAway":false,"alerts":[{"id":1731700000123,"t":1731700000123,"level":"warning","title":"Hạn mức 90%","body":"5h"}]}""",
        )
        assertEquals(1, st.recent.size)
        assertEquals(1, st.projects!![0].live)
        val a = st.accounts!!.list[0]
        assertTrue(a.active)
        assertEquals(92.0, a.fiveHour!!.pct, 1e-9)
        assertNull(a.sevenDay!!.resetsAt)
        assertEquals("soon", a.loginState)
        assertEquals(1731700000123.0, st.alerts!![0].id, 0.0)
        assertEquals("warning", st.alerts!![0].level)
    }

    @Test fun `RemoteState cu thieu truong van doc duoc`() {
        val st = AppJson.decodeFromString<RemoteState>("""{"version":1,"host":"PC","now":1,"live":[],"recent":[],"accounts":null}""")
        assertNull(st.accounts)
        assertNull(st.alerts)
        assertNull(st.projects)
    }

    @Test fun `Capabilities`() {
        val c = AppJson.decodeFromString<Capabilities>(
            """{"models":[{"value":"default","label":"Default","description":"d","resolved":"opus-5-5","efforts":["low","high"],"thinking":true,"fast":true}],
               "commands":[{"name":"compact","description":"nén","hint":"[ghi chú]"}],"outputStyles":["default","Explanatory"],"account":{"email":"a@b","plan":"max"},
               "efforts":["low","medium","high","xhigh","max"],"defaults":{"model":null,"modelValue":"default","modelLabel":"Opus","effort":"high","thinking":true,"flagSwitch":true,"fast":false,"outputStyle":"default"}}""",
        )
        assertEquals("compact", c.commands[0].name)
        assertEquals(2, c.outputStyles.size)
        assertTrue(c.models[0].fast)
        assertEquals("high", c.defaults.effort)
    }

    @Test fun `dang nhap`() {
        val r = AppJson.decodeFromString<HubLoginResponse>("""{"token":"abc","user":{"id":3,"username":"cam","admin":false}}""")
        assertEquals("abc", r.token)
        assertEquals("cam", r.user.username)
    }

    @Test fun `normalize dia chi hub`() {
        assertEquals("https://hub.vidu.com", normalizeHubUrl(" hub.vidu.com/ "))
        assertEquals("http://10.0.2.2:7790", normalizeHubUrl("http://10.0.2.2:7790//"))
        assertEquals("https://clauderc.caesarvn.xyz", normalizeHubUrl("HTTPS://clauderc.caesarvn.xyz/".replace("HTTPS", "https")))
        assertEquals("", normalizeHubUrl("   "))
    }

    @Test fun `trang thai va thoi gian tuong doi`() {
        assertEquals("Đang chạy", statusInfo("running").label)
        assertEquals("Cần duyệt", statusInfo("waiting").label)
        assertEquals("Rảnh", statusInfo("idle").label)
        assertEquals("Đang mở", statusInfo("starting").label)
        assertEquals("Đã tắt", statusInfo("off").label)
        val now = 10_000_000_000L
        assertEquals("vừa xong", relativeTime((now - 10_000).toDouble(), now))
        assertEquals("5 phút trước", relativeTime((now - 5 * 60_000).toDouble(), now))
        assertEquals("2 giờ trước", relativeTime((now - 2 * 3_600_000).toDouble(), now))
        assertEquals("3 ngày trước", relativeTime((now - 3 * 86_400_000L).toDouble(), now))
        assertNotNull(statusInfo("zzz"))
        assertFalse(statusInfo("zzz").label.isEmpty())
    }
}
