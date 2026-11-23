# نهر (Nahr)

تونل رمزنگاریشدهٔ چندترنسپورته با پنل وب RTL و محک داخلی. از صفر نوشته شده؛ هیچ کدی از پروژهٔ Kariz کپی نشده است (مجوز آن source-available است).

- ترنسپورتهای پشتیبانی شده: `tcp`, `tcpmux`, `ws`, `wss`, `udp`
- رمزنگاری: X25519 + HKDF-SHA256 + AES-256-GCM، احراز هویت با توکن
- پنل فارسی، SOCKS5، فوروارد پورت ثابت، محک ۱۰ حالته و دموی محلی

## نصب سریع

نیاز: **Node.js 20+** و npm. نیازی به کامپایلر نیست.

```bash
git clone https://github.com/batvin/nahr.git
cd nahr
npm install
npm test
```

اجرای دموی محلی (دو ایجنت + پنل):

```bash
npm run demo
```

سپس `http://localhost:8080/panel` را باز کنید.

## مستندات کامل

- [راهنمای فارسی و نحوهٔ نصب روی سرور](README_FA.md)
- [صفحهٔ وبسایت و مستندات](web/site/index.html)

## لایسنس

MIT — جزئیات در [لایسنس](LICENSE).
