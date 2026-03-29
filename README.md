# tutorbek.com

Mini backend bilan blog post publish va edit qilish uchun lokal server.

## Ishga tushirish

```bash
npm start
```

Server: `http://localhost:3000`

## Login va himoya

- Login URL: `http://localhost:3000/login`
- Parol hash ko'rinishida: `config/createpost-auth.json`
- To'g'ri paroldan keyin auth cookie beriladi va protected route'lar ochiladi.

## Editor URL

- Yangi post: `http://localhost:3000/blog/createpost`
- Mavjud postni edit: `http://localhost:3000/blog/createpost?slug=<post-slug>`

## Media upload

- Editor ichida `Img` va `PDF` tugmalari bor.
- Yuklangan fayllar `blog/media/` papkasida saqlanadi.
- Upload API: `POST /api/media/upload` (auth talab qiladi)
- Qo'llab-quvvatlanadigan turlar: rasm (`image/*`) va PDF (`application/pdf`)
- Maksimal fayl hajmi: 10MB

## Telegram integratsiya

- Publish qilinganda post Telegram kanalga yuboriladi.
- Update qilinganda o'sha Telegram xabari edit qilinadi.
- Telegram metadata `blog/posts.json` ichida saqlanadi (`messageId`, `chatId`, `syncedAt`).

### Tokenni shifrlangan holda saqlash

- Shifrlangan Telegram config fayli: `config/telegram.secure.json`
- Encrypt helper:

```bash
TELEGRAM_BOT_TOKEN="your-bot-token"
TELEGRAM_CHAT_ID="@your_channel"
TELEGRAM_BOT_USERNAME="@your_bot"
npm run encrypt:telegram
```

- `PUBLIC_BASE_URL` env o'zgaruvchisi Telegramdagi post linklar uchun ishlatiladi.
  - Misol: `PUBLIC_BASE_URL=https://tutorbek.com npm start`

## API

- `POST /api/publish` - yangi post yaratadi
- `GET /api/auth/status` - auth holatini qaytaradi
- `GET /api/posts/:slug` - edit uchun postni yuklaydi (auth talab qiladi)
- `PUT /api/posts/:slug` - o'sha postni update qiladi (yangi post yaratmaydi)
- `POST /api/media/upload` - rasm/PDF yuklaydi (auth talab qiladi)

`PUT /api/posts/:slug` paytida post slug va sana (`date`/`isoDate`) saqlanib qoladi.
# tutorbek.com
