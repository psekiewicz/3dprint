'use strict';
// Wysyłka e-maili przez SMTP (np. skrzynka przy domenie). Bez konfiguracji po prostu nic nie wysyła.
//
// Zmienne środowiskowe:
//   SMTP_HOST, SMTP_PORT (domyślnie 465), SMTP_USER, SMTP_PASS
//   MAIL_FROM     — nadawca, np. "Druk 3D <contact@example.com>" (domyślnie SMTP_USER)
//   MAIL_REPLY_TO — adres, na który trafiają odpowiedzi (gdy nadawcą jest np. noreply@)
//   MAIL_BCC      — dokąd idzie ukryta kopia każdego maila (domyślnie SMTP_USER, czyli własna skrzynka;
//                   "off" wyłącza kopie)
const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
const port = Number(process.env.SMTP_PORT) || 465;
const bcc = (process.env.MAIL_BCC || SMTP_USER || '').trim();

let transport = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  try {
    transport = require('nodemailer').createTransport({
      host: SMTP_HOST, port, secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  } catch {
    console.error('E-maile wyłączone: brak pakietu nodemailer (uruchom "npm install").');
  }
}

exports.enabled = () => !!transport;

// Zwraca 'sent', 'off' (brak konfiguracji lub adresu) albo 'failed'.
exports.send = async ({ to, subject, text }) => {
  if (!transport || !to) return 'off';
  try {
    await transport.sendMail({
      from: process.env.MAIL_FROM || SMTP_USER,
      replyTo: process.env.MAIL_REPLY_TO || undefined,
      bcc: bcc && bcc.toLowerCase() !== 'off' ? bcc : undefined,
      to, subject, text,
    });
    return 'sent';
  } catch (err) {
    console.error(`Nie udało się wysłać e-maila do ${to}: ${err.message}`);
    return 'failed';
  }
};
