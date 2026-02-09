const db = require('../../src/db');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const moment = require('moment');

// Läuft jeden Tag um 02:00
cron.schedule('0 2 * * *', async () => {
  console.log("🔔 Checking commercial packages expiring in 3 months...");

  const query = `
    SELECT 
        sp.id AS selected_package_id,
        sp.user_id,
        u.email,
        u.firstname,
        u.lastname,
        sp.end_date,
        p.name AS package_name
    FROM selected_packages sp
    JOIN packages p ON p.id = sp.package_id
    JOIN users u ON u.id = sp.user_id
    LEFT JOIN package_reminders pr 
          ON pr.selected_package_id = sp.id
          AND pr.reminder_type = '3_months_before'
    WHERE pr.id IS NULL
      AND p.registration_type = 'commercial'
      AND DATE(sp.end_date) = DATE(DATE_ADD(CURDATE(), INTERVAL 3 MONTH));
  `;

  const [rows] = await db.execute(query);

  if (!rows.length) {
    console.log("➡ No commercial reminders to send today.");
    return;
  }

  for (const pkg of rows) {
    // 👉 E-Mail erstellen
    const mailOptions = {
      from: "info@herando.com",
      to: pkg.email,
      subject: "Ihr Marketingpaket läuft bald ab",
      html: `
        <p>Sehr geehrte/r ${pkg.firstname} ${pkg.lastname},</p>

        <p>Ihr <strong>${pkg.package_name}</strong> läuft am 
        <strong>${moment(pkg.end_date).format("DD.MM.YYYY")}</strong> ab.</p>

        <p>Drei Monate vor Ablauf erhalten Sie diese Erinnerung, 
        damit Sie ausreichend Zeit haben zu kündigen oder zu verlängern.</p>

        <p>Mit freundlichen Grüßen<br>Ihr Herando-Team</p>
      `
    };

    try {
      await transporter.sendMail(mailOptions);

      // 👉 Eintrag speichern, damit die Mail nicht doppelt gesendet wird
      await db.execute(`
        INSERT INTO package_reminders 
        (selected_package_id, user_id, reminder_type) 
        VALUES (?, ?, '3_months_before')
      `, [pkg.selected_package_id, pkg.user_id]);

      console.log(`📧 Reminder sent to ${pkg.email}`);

    } catch (err) {
      console.error("❌ Error sending reminder: ", err);
    }
  }
});
