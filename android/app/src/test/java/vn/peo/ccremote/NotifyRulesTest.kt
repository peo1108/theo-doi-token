package vn.peo.ccremote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import vn.peo.ccremote.notify.NotifyKind
import vn.peo.ccremote.notify.NotifyRules
import vn.peo.ccremote.notify.Snap

/** Luật thông báo giống Notifier.swift. */
class NotifyRulesTest {
    private fun snap(status: String = "idle", pending: Int = 0, rejected: Boolean = false, remote: Boolean = true) = Snap(status, pending, rejected, remote)
    private fun decide(old: Snap?, now: Snap, primed: Boolean = true, enabled: Boolean = true, watching: Boolean = false) =
        NotifyRules.decide(primed, enabled, old, now, watching)

    @Test fun `xin quyen moi thi bao`() {
        assertEquals(NotifyKind.Permission, decide(snap("running"), snap("waiting", pending = 1)))
        assertEquals(NotifyKind.Permission, decide(snap("waiting", pending = 1), snap("waiting", pending = 2)))
    }

    @Test fun `van cung so luong cho duyet thi khong bao lai`() {
        assertNull(decide(snap("waiting", pending = 1), snap("waiting", pending = 1)))
        assertNull(decide(snap("waiting", pending = 2), snap("waiting", pending = 1)))
    }

    @Test fun `xong luot, bi dung, het han muc`() {
        assertEquals(NotifyKind.Done, decide(snap("running"), snap("idle")))
        assertEquals(NotifyKind.Done, decide(snap("starting"), snap("idle")))
        assertEquals(NotifyKind.Stopped, decide(snap("running"), snap("off")))
        assertEquals(NotifyKind.Limit, decide(snap("running"), snap("running", rejected = true)))
        assertNull(decide(snap("idle", rejected = true), snap("idle", rejected = true)))
    }

    @Test fun `khong bao xong viec hai lan`() {
        assertNull(decide(snap("idle"), snap("idle")))
        assertNull(decide(snap("off"), snap("idle")))
    }

    @Test fun `chua prime, tat thong bao, phien moi xuat hien thi khong bao`() {
        assertNull(decide(snap("running"), snap("idle"), primed = false))
        assertNull(decide(snap("running"), snap("idle"), enabled = false))
        assertNull(decide(null, snap("waiting", pending = 1)))
    }

    @Test fun `khong bao phien dang mo tren man hinh`() {
        assertNull(decide(snap("running"), snap("idle"), watching = true))
    }

    @Test fun `phien VS Code chi bao khi gan dien thoai hoac may de yen`() {
        // đang ngồi máy (remote=false): im lặng
        assertNull(decide(snap("running", remote = false), snap("waiting", pending = 1, remote = false)))
        assertNull(decide(snap("running", remote = false), snap("idle", remote = false)))
        // rời máy: câu hỏi vẫn chờ thì báo lúc đó (pending không tăng nhưng trước đó chưa remote)
        assertEquals(NotifyKind.Permission, decide(snap("waiting", pending = 1, remote = false), snap("waiting", pending = 1, remote = true)))
        // gắn điện thoại: báo như bình thường
        assertEquals(NotifyKind.Done, decide(snap("running", remote = true), snap("idle", remote = true)))
    }
}
