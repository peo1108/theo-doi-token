package vn.peo.ccremote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import vn.peo.ccremote.ui.InlineParser
import vn.peo.ccremote.ui.MarkdownParser
import vn.peo.ccremote.ui.MarkdownParser.Align
import vn.peo.ccremote.ui.MarkdownParser.Block
import vn.peo.ccremote.ui.Span

class MarkdownTest {
    private fun parse(s: String) = MarkdownParser.parse(s)

    @Test fun `bang co dau gach nghieng va can cot`() {
        val md = "| Thứ | Reboot | Phút |\n|:---|:---:|--:|\n| a | b | 1 |\n| c | d | 2 |"
        val t = parse(md).single() as Block.Table
        assertEquals(listOf(Align.Leading, Align.Center, Align.Trailing), t.aligns)
        assertEquals(3, t.rows.size)
        assertEquals(listOf("Thứ", "Reboot", "Phút"), t.rows[0])
        assertEquals(listOf("c", "d", "2"), t.rows[2])
    }

    @Test fun `dau gach dung trong o bang duoc giu nguyen`() {
        val md = "| Lệnh | Ghi chú |\n|---|---|\n| `a \\| b` | cột hai |\n| x \\| y | z |"
        val t = parse(md).single() as Block.Table
        assertEquals(listOf("`a | b`", "cột hai"), t.rows[1])
        assertEquals(listOf("x | y", "z"), t.rows[2])
        assertEquals(2, t.rows[1].size)
    }

    @Test fun `br trong o thanh xuong dong`() {
        val md = "| A | B |\n|---|---|\n| một<br>hai<br/>ba<BR />bốn | x |"
        val t = parse(md).single() as Block.Table
        assertEquals("một\nhai\nba\nbốn", t.rows[1][0])
    }

    @Test fun `bang giong phien VS Code cua smoke-server`() {
        val md = "Không phải đăng nhập lại.\n\n## Sau khi reboot\n\n| Thứ | Reboot thì sao | Phút |\n|---|---|--:|\n" +
            "| **Tailscale trên PC** | Chạy dạng service | 0 |\n| `tailscale serve` | Cấu hình được lưu<br>tự chạy lại | 1.5 |\n" +
            "| **App CC Remote** | Ghép một lần; lệnh `a \\| b` vẫn nguyên | 12 |\n\n1. Bật máy\n2. Mở app\n   - không cần làm gì thêm\n\n> Mẹo: tắt *key expiry*."
        val b = parse(md)
        assertTrue(b[0] is Block.Paragraph)
        assertEquals(Block.Heading(2, "Sau khi reboot"), b[1])
        val t = b[2] as Block.Table
        assertEquals(4, t.rows.size)
        assertEquals(Align.Trailing, t.aligns[2])
        assertEquals("Cấu hình được lưu\ntự chạy lại", t.rows[2][1])
        assertEquals("Ghép một lần; lệnh `a | b` vẫn nguyên", t.rows[3][1])
        val l = b[3] as Block.ListBlock
        assertEquals(listOf("1.", "2.", "•"), l.items.map { it.marker })
        assertEquals(1, l.items[2].indent)
        assertTrue(b[4] is Block.Quote)
    }

    @Test fun `dong khong phai bang khi thieu dong phan cach`() {
        val b = parse("| a | b |\n| c | d |")
        assertTrue(b.single() is Block.Paragraph)
    }

    @Test fun `khoi code va tieu de`() {
        val b = parse("# Một\n\n```js\nconsole.log(\"xin chào\")\n```\n\ntext sau")
        assertEquals(Block.Heading(1, "Một"), b[0])
        assertEquals(Block.Code("js", "console.log(\"xin chào\")"), b[1])
        assertEquals(Block.Paragraph("text sau"), b[2])
    }

    @Test fun `khoi code khong dong van lay het`() {
        val b = parse("```\na\nb")
        assertEquals(Block.Code("", "a\nb"), b.single())
    }

    @Test fun `danh sach long va checkbox`() {
        val l = parse("- một\n  - lồng\n- [ ] chưa\n- [x] xong\n* sao").single() as Block.ListBlock
        assertEquals(listOf("•", "•", "☐", "☑", "•"), l.items.map { it.marker })
        assertEquals(1, l.items[1].indent)
        assertEquals("xong", l.items[3].text)
    }

    @Test fun `dong tiep noi cua muc danh sach`() {
        val l = parse("- một\n  tiếp theo\n- hai").single() as Block.ListBlock
        assertEquals(2, l.items.size)
        assertEquals("một\ntiếp theo", l.items[0].text)
    }

    @Test fun `duong ke ngang khong phai danh sach`() {
        assertTrue(parse("---").single() is Block.Rule)
        assertTrue(parse("***").single() is Block.Rule)
        assertTrue(parse("* * *").single() is Block.Rule)
    }

    @Test fun `trich dan nhieu dong va CRLF`() {
        val b = parse("> một\r\n> hai\r\n\r\nđoạn")
        assertEquals(Block.Quote("một\nhai"), b[0])
        assertEquals(Block.Paragraph("đoạn"), b[1])
    }

    @Test fun `tieu de can dau cach sau dau thang`() {
        assertTrue(parse("#không").single() is Block.Paragraph)
        assertEquals(Block.Heading(3, "ba"), parse("### ba").single())
        assertTrue(parse("####### bảy").single() is Block.Paragraph)
    }

    // ---- inline ----

    @Test fun `inline dam nghieng code link`() {
        val s = InlineParser.spans("a **đậm** và *nghiêng* với `code` và [liên kết](https://x.y/z) và ~~gạch~~")
        assertEquals(Span("a "), s[0])
        assertEquals(Span("đậm", bold = true), s[1])
        assertEquals(Span("nghiêng", italic = true), s[3])
        assertEquals(Span("code", code = true), s[5])
        assertEquals(Span("liên kết", link = "https://x.y/z"), s[7])
        assertEquals(Span("gạch", strike = true), s[9])
    }

    @Test fun `inline long nhau`() {
        val s = InlineParser.spans("**đậm *và nghiêng* nữa**")
        assertEquals(listOf(Span("đậm ", bold = true), Span("và nghiêng", bold = true, italic = true), Span(" nữa", bold = true)), s)
    }

    @Test fun `inline giu nguyen dau sao va gach duoi trong tu`() {
        assertEquals(listOf(Span("snake_case_name và 2 * 3 * 4")), InlineParser.spans("snake_case_name và 2 * 3 * 4"))
        assertEquals(listOf(Span("*không đóng")), InlineParser.spans("*không đóng"))
    }

    @Test fun `inline code giu ky tu dac biet va thoat ky tu`() {
        assertEquals(listOf(Span("a **b** c", code = true)), InlineParser.spans("`a **b** c`"))
        assertEquals(listOf(Span("a|b"), Span("x", bold = true)), InlineParser.spans("a\\|b**x**"))
        assertEquals(listOf(Span("*sao*")), InlineParser.spans("\\*sao\\*"))
        val dbl = InlineParser.spans("``co`de``")
        assertEquals(listOf(Span("co`de", code = true)), dbl)
    }

    @Test fun `inline link long chu dam`() {
        val s = InlineParser.spans("[**đậm**](http://a)")
        assertEquals(listOf(Span("đậm", bold = true, link = "http://a")), s)
        assertNull(InlineParser.spans("[không có url]").firstOrNull()?.link)
        assertFalse(InlineParser.spans("[a](b)").isEmpty())
    }
}
