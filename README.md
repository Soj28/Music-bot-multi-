# Discord Music Bot — Multi

Discord Music Bot hỗ trợ nhiều bot Discord hoạt động đồng thời, cho phép sử dụng các bot trong nhiều voice channel khác nhau.

## ✨ Tính năng

* 🎵 Phát nhạc trong voice channel
* 🤖 Hỗ trợ nhiều Discord Bot
* 🎧 Mỗi bot có thể hoạt động ở một voice channel riêng
* 🔀 Phân chia bot theo voice channel
* 🔒 Bot đang được sử dụng sẽ không được bot khác sử dụng đồng thời
* ⏯️ Play / Pause
* ⏭️ Skip
* 🔁 Loop
* 🔀 Shuffle
* 📜 Queue
* 🔊 Điều chỉnh âm lượng
* 🎛️ Bộ lọc âm thanh
* 🚪 Tự động tham gia voice channel theo cấu hình
* 💾 Lưu cấu hình voice channel
* ⚡ Slash Commands

## 🛠️ Công nghệ

* Node.js
* Discord.js
* JavaScript
* FFmpeg
* Opus

## 📋 Yêu cầu

* Node.js
* npm
* FFmpeg
* Discord Bot Tokens

## 📥 Cài đặt

Clone repository:

```bash
git clone https://github.com/Soj28/Music_bot-Multi.git
cd Music_bot-Multi
```

Cài đặt các package:

```bash
npm install
```

## 🔐 Cấu hình

Tạo file cấu hình môi trường `.env` trên máy và điền các Bot Token cần thiết.

Ví dụ:

```env
MASTER_TOKEN=YOUR_MASTER_BOT_TOKEN
BOT1_TOKEN=YOUR_BOT1_TOKEN
BOT2_TOKEN=YOUR_BOT2_TOKEN
BOT3_TOKEN=YOUR_BOT3_TOKEN
```

Số lượng bot phụ thuộc vào cấu hình của project.

**Không chia sẻ hoặc upload file `.env` lên GitHub.**

## ▶️ Chạy bot

```bash
npm start
```

Hoặc:

```bash
node index.js
```

## 📁 Cấu trúc project

```text
Music bot (Multi)/
├── index.js
├── package.json
├── package-lock.json
├── README.md
├── .gitignore
├── voice-config.json
├── bots/
└── music/
```

> `.env` và `node_modules/` được bỏ qua bởi `.gitignore` và không đưa lên repository.

## 🤖 Kiến trúc Multi-Bot

Project sử dụng mô hình nhiều Discord Bot:

```text
                    Master Bot
                        │
          ┌─────────────┼─────────────┐
          │             │             │
        Bot 1         Bot 2         Bot 3
          │             │             │
       Voice 1       Voice 2       Voice 3
```

Mỗi bot con có thể đảm nhiệm một voice channel riêng.

Khi một bot đang được sử dụng, hệ thống có thể đánh dấu bot đó là đang bận để tránh việc sử dụng cùng một bot cho nhiều voice channel.

## 💾 Voice Configuration

Cấu hình voice channel được lưu trong:

```text
voice-config.json
```

File này giúp giữ cấu hình sau khi bot được khởi động lại.

## 🔒 Bảo mật

Không đưa các thông tin sau lên GitHub:

* Discord Bot Token
* API Key
* Password
* Secret Key
* `.env`

Nếu Bot Token đã bị công khai, hãy reset token trong Discord Developer Portal.

## 📄 License

MIT License.
