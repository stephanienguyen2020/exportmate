# ExportMate — Những thứ cần sửa

Danh sách được lập ngày 13/10/2026 sau khi đọc code, chạy build/test và chụp màn hình ở 390 px, 1440 px và 1366×680. Cùng ngày, phần lớn các mục đã được sửa. Mục nào còn lại được ghi ở phần "Chưa làm" kèm lý do.

Trạng thái sau khi sửa:

- `npm run build`: chunk chính giảm từ 546 kB xuống 364 kB.
- Playwright: 16 pass, 1 skip. Test bị skip là round-trip với backend thật; chạy với `TEST_REAL_BACKEND=1` và backend local thì cũng pass.
- Backend `pytest`: 72 pass. `alembic check`: không lệch.
- `ai/server` `npm test`: 47 pass.

Chi tiết từng lần kiểm tra nằm ở [VALIDATION.md](VALIDATION.md), mục "Fixes from docs/FIXES.md".

Ký hiệu: `[x]` là đã sửa, `[ ]` là chưa làm. **P0** = lỗi rõ ràng hoặc bảo mật, **P1** = nên sửa sớm, **P2** = cải thiện thêm.

---

## 1. Giao diện (UI)

### P0

- [x] **Sidebar bị cắt khi màn hình thấp.** Sidebar giờ cuộn được, và khoảng cách được thu gọn khi màn hình thấp hơn 760 px. Nút "Sign out" luôn tới được.
- [x] **Mất khoảng trắng khi CSS ẩn `<br>`.** Giờ hiện đúng "Start with your supplier." và "Less setup. More clarity.".
- [x] **Nút chat nổi che nội dung.**
  - Không hiện nút chat trên các trang đăng nhập, đăng ký và tài khoản.
  - Footer có thêm khoảng trống phía dưới, để nút không che nội dung cuối trang.
  - Nút nhỏ hơn trên màn hình ≤480 px.
- [x] **Menu mobile thiếu "Sign out".** Đã thêm Sign out, đánh dấu trang đang mở (`aria-current`), và thêm `aria-expanded` / `aria-controls` cho nút mở menu.

### P1

- [x] **Bảng đơn hàng trên mobile.** Ở ≤760 px, mỗi đơn hiện thành một thẻ, có đủ Supplier, Destination, Value, Ships và Status trong màn hình.
- [x] **Toast báo lỗi.** Toast lỗi có màu đỏ, icon cảnh báo, `role="alert"` và hiện lâu hơn (9 giây).
- [x] **Badge "ALL CLEAR" và "0 orders affected"** giờ có màu xanh.
- [x] **Topbar mobile.** Ẩn nút Maker/Buyer view; breadcrumb quá dài thì cắt bằng dấu "…".
- [x] **Dữ liệu viết cứng**, giờ lấy theo hồ sơ và vai trò thật:
  - Logo hiện chữ cái đầu của tên công ty.
  - Dưới tên người dùng hiện vai trò thật (Owner, Editor hoặc Viewer).
  - Workspace thật hiện ngày hôm nay.
  - Action card hiện tuyến thương mại của công ty.
  - Chữ ký tin nhắn và "Suggested owner" lấy từ hồ sơ.
  - Nhãn "ORDER DETAIL" ở workspace thật.
  - Số đơn mẫu đếm từ dữ liệu thật.
  - Chấm báo ở Rule watch chỉ hiện trong demo khi có đơn bị ảnh hưởng.
  - Ghi rõ "3 sample source collections".
- [x] **Nút trông bấm được nhưng không làm gì.**
  - Bỏ mũi tên ▾ ở ô workspace.
  - Nút profile dùng mũi tên ↗ (vì chỉ mở trang Account).
  - Ẩn Maker/Buyer view trong workspace thật.
  - Nút "Run demo" không còn bị khóa: bấm vào sẽ hiện giải thích.
  - Nút "Explore your corridor" giờ mở Trade map.
- [x] **Cùng một con số mang hai nhãn khác nhau.** Workspace thật giờ ghi "exposed order value" ở cả hai chỗ.
- [x] **Data room chỉ hiện 10 lỗi đầu.** Giờ có dòng "…and N more" và "Showing the first 10 of N rows".
- [x] **Data room không giải thích cho viewer.** Có ghi chú giải thích; file kéo thả vào sẽ hiện toast báo lỗi thay vì bị bỏ qua.
- [x] **Hướng dẫn tiền tệ.** Template có thêm cột `currency`. Hướng dẫn ghi rõ: nếu không có cột này thì dùng tiền tệ của công ty (hoặc USD trong demo).
- [x] **Upload lại file đã import.** Hiện thông báo khi file trùng với một import đã commit.
- [x] **Trang News watch quá dài.** Mỗi thẻ chỉ hiện 3 SKU kèm nút "Show all N items". Trang ngắn hơn khoảng 600 px.
- [x] **Nút "Scan now" hiện với mọi người.** Nút bị khóa và có giải thích trong demo và với viewer. Server cũng chỉ nhận yêu cầu từ owner/editor (xem mục 3).
- [x] **Heading trang chi tiết đơn** giờ là "Source and analysis".
- [x] **Bộ lọc Orders bị giữ lại.** Vào Orders bằng sidebar hoặc menu mobile sẽ reset về "All orders".
- [x] **Xóa playbook rule.** Phải bấm hai lần ("Delete?"), có toast xác nhận đã xóa.

### P2 — accessibility

- [x] Tab lọc có `aria-pressed`; ô tìm kiếm có `aria-label`.
- [x] Focus trong modal không còn nhảy ở mỗi bước demo. Focus trap có thêm `a[href]` và `select`.
- [x] Chat không gửi tin khi đang gõ dở bằng IME (`isComposing`).
- [x] Trang đăng nhập không còn áp quy tắc 8 ký tự; placeholder là "Your password".

---

## 2. Frontend — logic

### P0

- [x] **Deep link sau khi đăng nhập.** `intendedRoute()` giờ nhận cả `map/...` và `news`. "Explore the demo" cũng quay về trang người dùng đã định mở.
- [x] **Chat khi đăng xuất.** `clearChat()` xóa lịch sử và tạo phiên audit mới khi đăng xuất và khi đăng nhập. Câu trả lời đang chờ bị hủy.
- [x] **Error Boundary.** Đã bọc quanh từng trang, workspace, News highlights và chat widget.

### P1

- [x] **Lỗi Firebase** giờ hiện bằng câu dễ hiểu (`errorMessage` trong `auth.ts`).
- [x] **Link ở trang Terms** đổi thành "Create an account".
- [x] **Link xác minh email mở ở thiết bị khác.** Mã xác minh vẫn được áp dụng, sau đó trang mời đăng nhập. Mã được xóa khỏi URL sau khi dùng.
- [x] **Kiểm tra CSV ở demo** giờ dùng chung quy tắc với backend (`src/order-csv.ts`): HS code, mã tiền tệ, độ dài trường, số dòng, tối đa 2 chữ số thập phân.
- [x] **Giới hạn file** thống nhất 4 MB ở UI, proxy Vercel và backend.
- [x] **Chat có thể treo.** `askAgent` nhận `AbortSignal`; câu trả lời quá 120 giây sẽ bị hủy kèm thông báo.
- [x] **Hàm `ArrowUp`** đã bị xóa.

### P2

- [x] **Bundle chính** giảm từ 546 kB xuống 364 kB: Firebase SDK và PapaParse giờ chỉ tải khi cần.
- [x] **Tách `main.tsx`** thành component theo trang: `frontend/src/workspace/` (mỗi trang một file, bảng route trong `Workspace.tsx`; `store.ts` là nơi duy nhất phân biệt demo và API). `TradeMap.tsx` cũng được tách thành `frontend/src/trade-map/`.

---

## 3. AI service (`ai/server`)

### P0

- [x] **News sources theo công ty** (`access.js`):
  - Source built-in dùng chung cho mọi công ty. Khi một công ty tắt nó, chỉ công ty đó bị ảnh hưởng (lưu ở `companySources/{companyId}`).
  - Source tự thêm thuộc về công ty đã thêm nó. Chỉ công ty đó thấy source, cùng các bài báo và cảnh báo từ source đó. Điều này áp dụng cho `/api/sources`, `/api/impacts` và các tool của agent.
  - Giới hạn 10 source tự thêm cho mỗi công ty.
- [x] **SSRF.** IP được kiểm tra ngay lúc socket kết nối, nên DNS rebinding không còn tác dụng. Dải IP bị chặn được mở rộng; địa chỉ NAT64 và 6to4 được xét theo IPv4 nằm bên trong. Feed được đọc theo stream và dừng khi vượt 3 MB.
- [x] **`POST /api/scan`.** Chỉ owner/editor hoặc Cloud Scheduler được gọi. Khóa `locks/scan` được lấy trong một Firestore transaction, nên hai lần scan không thể chạy cùng lúc.

### P1

- [x] **Bằng chứng cho auditor** giờ chỉ gồm tin nhắn của người dùng và kết quả tool trong lượt hiện tại. Phiên `exportmate-dc` đã sửa mục này.
- [x] **Không gửi `thought` cho client.** Server bỏ `thought` khỏi các bước stream và khỏi `/api/audits`; UI cũng không hiển thị nữa. Bản đầy đủ vẫn lưu trong Firestore để kiểm tra.
- [x] **Audit theo công ty.** Audit có `companyId` chỉ trả về khi có token của người cùng công ty.
- [x] **Ghi rõ dữ liệu mẫu.** Trong workspace thật, Overview và News watch ghi rõ cảnh báo được so với tồn kho mẫu, không phải tồn kho của công ty.
- [x] **Lọc tin.** Sau Gemini có thêm bước loại các bài nói về hàng hóa khác (ca cao, cà phê…) mà không nhắc tới đồ gỗ (`relevance.js`).
- [x] **Giới hạn body và feed.** Body request quá 100 KB bị trả 413 và phần thừa không được giữ lại. Feed bị giới hạn khi đọc theo stream.
- [x] **Feed nén bị treo làm sập service.** Một feed gzip gửi dở rồi dừng khiến lỗi timeout không có ai bắt, và cả process Node bị sập. Thêm source (`POST /api/sources`) đọc feed ngay trong request, nên editor nào cũng có thể gây ra lỗi này. Giờ `feeds.js` dùng `stream.pipeline`, nên lỗi được chuyển sang bộ giải nén; phần body không đọc (redirect, lỗi HTTP) được hủy thay vì để chảy tiếp.

### P2

- [x] Thêm test: access, limits, feeds, relevance, calc (tổng 47 test).
- [x] Lịch scan đọc từ biến môi trường `SCAN_SCHEDULE`.
- [x] Máy tính trong agent chấp nhận tab và xuống dòng.

---

## 4. Backend

### P1

- [x] **Kiểm tra token bị thu hồi.** Kết quả tra user trên Firebase được cache 1 phút mỗi user và xóa ngay khi đăng xuất mọi nơi. Tài khoản bị vô hiệu hóa nhận 401.
- [x] **Rate limit upload:** 60 lần mỗi user mỗi giờ (`core/rate_limit.py`). Bộ đếm nằm trong bộ nhớ, mỗi instance đếm riêng.
- [x] **Dọn import cũ.** Có lệnh `python -m app.cleanup_imports --older-than-days 30`, xóa các upload chưa commit; import đã commit được giữ lại.
- [x] **Onboarding trùng.** Khóa dòng user (`SELECT … FOR UPDATE`) trước khi kiểm tra membership.
- [x] **Tiền tệ.**
  - CSV và onboarding chỉ nhận mã ISO 4217.
  - Quy ước "×100 cho mọi loại tiền" được ghi rõ trong code và CLAUDE.md.
- [x] **`sourcesCheckedAt` luôn là null.** Đã ghi chú trong code: backend chưa biết lúc nào source được kiểm tra; dashboard lấy thời gian scan từ `/api/impacts`.

---

## 5. Tooling, CI, tài liệu

- [x] `package.json` khai báo `"engines": { "node": ">=22.18" }` và có file `.nvmrc` (24).
- [x] Cập nhật CLAUDE.md: Firebase Auth, hai loại session, lazy-load, phân quyền sources, khóa scan, tiền tệ, giới hạn upload, lệnh dọn import.
- [x] Thêm mục mới trong VALIDATION.md. Câu "demo sign-in restores the intended page" giờ đúng trở lại.
- [x] Thêm test Playwright `tests/demo-ui.spec.ts` (9 test) và test toast lỗi.
- [x] Test round-trip với backend thật (`tests/local-backend.spec.ts`) đã hỏng từ trước vì không điền ô mô tả công ty bắt buộc khi onboarding. Đã sửa.

---

## Chưa làm

Các mục dưới đây cần quyết định, hạ tầng mới, hoặc là tính năng mới, không phải lỗi:

- [x] **Commit `.github/` và các thay đổi.** Đã commit trong `5c9a187` và push lên `main`.
- [ ] **API mời thành viên / đổi role.** Đây là tính năng mới. Hiện production chỉ có role owner.
- [ ] **Lưu file CSV trên Cloud Storage** thay vì Postgres. Cần thêm hạ tầng (kế hoạch Phase 2). Trước mắt đã có lệnh dọn import cũ.
- [ ] **Chạy scan nền thay vì trong một request.** Trên Cloud Run, CPU bị giới hạn sau khi đã trả response, nên cần Cloud Tasks, Cloud Run Jobs, hoặc bật "CPU always allocated".
- [ ] **Các tính năng còn thiếu theo REQUIREMENTS v1:** regulations/obligations, analysis runs và reports, actions (draft → approve → send), contact form.
- [ ] **Gộp các cảnh báo trùng sự kiện giữa các lần scan.** Hiện chỉ gộp được trong cùng một batch Gemini.
- [ ] **Test Playwright cho trade map** (với API giả).
- [ ] **Dữ liệu Firestore đã có** không được sửa:
  - Cảnh báo ca cao Ghana vẫn còn.
  - Các bản ghi cũ không có `sourceIds`, nên vẫn hiện với mọi người.
  - Source tự thêm từ trước khi có chủ sở hữu được xem là source dùng chung.
