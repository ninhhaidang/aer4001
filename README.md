# MODIS LST Gap-filling cho Việt Nam

## Giới thiệu

Dự án này phát triển một phương pháp để lấp trống (gap-filling) dữ liệu nhiệt độ bề mặt đất (LST) từ vệ tinh MODIS cho khu vực Việt Nam. Thuật toán sử dụng kết hợp dữ liệu từ hai vệ tinh MODIS (Terra và Aqua) và áp dụng các phương pháp nội suy thời gian và không gian để tạo ra bộ dữ liệu LST liên tục không có các điểm dữ liệu bị thiếu.

## Nội dung dự án

Dự án bao gồm các thành phần chính sau:

- **du-an-thuc-te.js**: Script Google Earth Engine (GEE) thực hiện toàn bộ quy trình xử lý dữ liệu LST
- **analyze.py**: Script Python để phân tích và trực quan hóa dữ liệu CSV được xuất từ GEE
- **csvdata/**: Thư mục chứa các file CSV được xuất từ GEE, bao gồm:
  - Chuỗi thời gian LST tại Hà Nội
  - Thống kê mô tả về LST từ các nguồn khác nhau
  - Thống kê về độ phủ của pixel

## Quy trình xử lý

Script phân tích của chúng tôi thực hiện các bước sau:

1. **Thu thập dữ liệu**: Lấy dữ liệu LST từ bộ sưu tập MODIS Terra (MOD11A1) và MODIS Aqua (MYD11A1)
2. **Lọc chất lượng**: Loại bỏ các điểm dữ liệu bị mây che phủ hoặc có chất lượng kém
3. **Kết hợp dữ liệu**: Gộp dữ liệu từ cả Terra và Aqua để tăng cường độ phủ
4. **Chuyển đổi đơn vị**: Chuyển từ số kỹ thuật số (DN) sang độ C
5. **Tính toán giá trị trung bình dài hạn (LTM)** cho toàn bộ giai đoạn nghiên cứu
6. **Tính toán phần dư (residuals)**: Trừ LTM từ mỗi ảnh LST hàng ngày
7. **Làm mịn không gian**: Áp dụng bộ lọc focal mean để giảm nhiễu
8. **Điền khuyết**: Thực hiện nội suy thời gian và không gian để điền các điểm dữ liệu bị thiếu
9. **Tái tạo LST cuối cùng**: Cộng phần dư đã được điền khuyết với LTM

## Cách sử dụng

### Google Earth Engine Script (du-an-thuc-te.js)

1. Truy cập [Google Earth Engine](https://code.earthengine.google.com/)
2. Copy và paste nội dung của file `du-an-thuc-te.js` vào Code Editor
3. Chạy script để xử lý dữ liệu LST và xuất kết quả

### Phân tích dữ liệu xuất (analyze.py)

1. Cài đặt các thư viện Python cần thiết:
   ```
   pip install pandas matplotlib numpy
   ```
2. Chạy script để phân tích dữ liệu:
   ```
   python analyze.py
   ```

## Kết quả

Kết quả của dự án bao gồm:

- Bộ dữ liệu LST liên tục cho khu vực Việt Nam
- Các thống kê mô tả về LST và độ phủ pixel
- Chuỗi thời gian LST tại điểm mẫu (Hà Nội)

## Liên hệ

- Người thực hiện: Ninh Hai Dang
- Email: ninhhaidangg@gmail.com
