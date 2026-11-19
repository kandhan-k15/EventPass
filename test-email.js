// Usage (from the EventPass folder):
//   node --env-file=.env test-email.js your-real-email@gmail.com
// It checks your Brevo settings, logs in to Brevo, and sends one test email.

const nodemailer = require("nodemailer");

const {
  SMTP_HOST = "smtp-relay.brevo.com",
  SMTP_PORT = "587",
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
} = process.env;
const to = process.argv[2];

function explain(err) {
  console.log("\nWhat Brevo / the network said:");
  console.log("  code:", err.code || "(none)", "| reply number:", err.responseCode || "(none)");
  console.log("  message:", err.response || err.message);
  console.log("\nWhat it usually means:");
  if (err.code === "EAUTH" || err.responseCode === 535) {
    console.log("  - Brevo refused the login. SMTP_USER must be the SMTP login from Brevo > Settings > SMTP & API > SMTP,");
    console.log("    and SMTP_PASS must be an SMTP key (not your account password, not an API key).");
  } else if (["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNREFUSED", "EDNS", "ENOTFOUND"].includes(err.code)) {
    console.log("  - Your computer could not reach Brevo. A college or office network often blocks port 587.");
    console.log("    Try SMTP_PORT=2525 in .env, or use your phone's hotspot, then run this test again.");
  } else if (err.code === "EENVELOPE" || (err.responseCode >= 550 && err.responseCode < 560)) {
    console.log("  - Brevo does not accept the sender (SMTP_FROM). Add it in Brevo > Senders, Domains & Dedicated IPs,");
    console.log("    confirm it with the 6-digit code Brevo emails you, and do not use the xxx@smtp-brevo.com login as the sender.");
  } else {
    console.log("  - Copy the lines above and send them to me.");
  }
}

async function main() {
  const maskedUser = SMTP_USER ? "***@" + (SMTP_USER.split("@")[1] || "(no @ in SMTP_USER)") : "(missing)";
  console.log("Host:", SMTP_HOST, "| Port:", SMTP_PORT);
  console.log("SMTP_USER:", maskedUser);
  console.log("SMTP_PASS:", SMTP_PASS ? "set (" + SMTP_PASS.length + " characters)" : "(missing)");
  console.log("SMTP_FROM:", SMTP_FROM || "(missing)");

  const problems = [];
  if (!SMTP_USER) problems.push("SMTP_USER is missing in .env");
  if (!SMTP_PASS) problems.push("SMTP_PASS is missing in .env");
  if (!SMTP_FROM) problems.push("SMTP_FROM is missing in .env");
  if (SMTP_PASS && SMTP_PASS.startsWith("xkeysib-")) {
    problems.push("SMTP_PASS looks like a Brevo API key (starts with xkeysib-). SMTP needs an SMTP key (starts with xsmtpsib-)");
  }
  if (SMTP_FROM && SMTP_FROM.toLowerCase().endsWith("@smtp-brevo.com")) {
    problems.push("SMTP_FROM is the technical @smtp-brevo.com login. Use a sender you verified in Brevo instead");
  }
  if (SMTP_FROM && /@(gmail|yahoo|outlook|hotmail)\./i.test(SMTP_FROM)) {
    console.log("\nNote: a free-mail sender (Gmail, Yahoo...) sent through Brevo often lands in spam or is blocked.");
  }
  if (problems.length) {
    console.log("\nProblems found in your settings:");
    problems.forEach((p) => console.log("  -", p));
    if (!SMTP_USER || !SMTP_PASS || !SMTP_FROM) return;
  }

  const port = Number(SMTP_PORT);
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });

  console.log("\nStep 1: connecting and logging in to Brevo...");
  try {
    await transporter.verify();
    console.log("  OK: Brevo accepted your login.");
  } catch (err) {
    console.log("  FAILED.");
    return explain(err);
  }

  if (!to) {
    console.log("\nStep 2 skipped. Run again with an email address to send a test:");
    console.log("  node --env-file=.env test-email.js your-real-email@gmail.com");
    return;
  }

  console.log("\nStep 2: sending a test email to", to, "...");
  try {
    const info = await transporter.sendMail({
      from: { name: "EventPass", address: SMTP_FROM },
      to,
      subject: "EventPass test email",
      text: "If you can read this, EventPass can send email through Brevo.",
    });
    console.log("  Brevo accepted it. accepted:", info.accepted, "rejected:", info.rejected);
    console.log("  Brevo's reply:", info.response);
    console.log("\nNow check your inbox AND spam folder (can take a minute).");
    console.log("Still nothing? Open Brevo > Transactional > Logs: it shows delivered, deferred, blocked or bounced.");
  } catch (err) {
    console.log("  FAILED.");
    explain(err);
  }
}

main();