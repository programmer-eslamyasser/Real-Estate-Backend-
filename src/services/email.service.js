const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

const port = Number(process.env.EMAIL_PORT) || 587;
const secure = port === 465 || process.env.EMAIL_SECURE === 'true';

const transporter = nodemailer.createTransport({
  host:   process.env.EMAIL_HOST || 'smtp.resend.com',
  port:   port,
  secure: secure,
  auth: {
    user: process.env.EMAIL_USER || 'resend',
    pass: process.env.EMAIL_PASS || process.env.RESEND_API_KEY,
  },
  tls: {
    rejectUnauthorized: false
  },
  connectionTimeout: 10000,
  socketTimeout: 10000,
});

/**
 * Resend HTTPS REST API direct sender.
 * Highly recommended for Vercel Serverless Functions to avoid TCP/SMTP socket timeouts.
 */
const sendEmailViaResendHttp = async ({ to, subject, html }) => {
  const apiKey = process.env.RESEND_API_KEY || (process.env.EMAIL_PASS?.startsWith('re_') ? process.env.EMAIL_PASS : null);
  if (!apiKey) return null;

  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'AQARIO Luxe <onboarding@resend.dev>';
  
  logger.info(`[EmailService] Sending email via Resend HTTPS REST API to: ${to}`);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: from,
      to: Array.isArray(to) ? to : [to],
      subject: subject,
      html: html,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const errorMsg = data?.message || data?.error || res.statusText;
    logger.error(`[EmailService] ❌ Resend API HTTP ${res.status} Error: ${JSON.stringify(data)}`);
    throw new Error(`Resend API Error (${res.status}): ${errorMsg}`);
  }

  logger.info(`[EmailService] ✅ Email sent successfully via Resend API. ID: ${data.id}`);
  return { messageId: data.id };
};

const sendEmail = async ({ to, subject, html }) => {
  if (process.env.NODE_ENV === 'test') {
    logger.info(`[EmailService] Test environment: Skipping actual email to ${to}`);
    return { messageId: 'test-message-id' };
  }

  // 1. Try Resend HTTPS REST API first (Ideal for Vercel Serverless Functions)
  const hasResendKey = !!(process.env.RESEND_API_KEY || (process.env.EMAIL_PASS && process.env.EMAIL_PASS.startsWith('re_')));
  if (hasResendKey) {
    try {
      return await sendEmailViaResendHttp({ to, subject, html });
    } catch (resendErr) {
      logger.warn(`[EmailService] Resend HTTPS API failed, falling back to SMTP: ${resendErr.message}`);
    }
  }

  // 2. Fallback to Nodemailer SMTP Transport
  try {
    logger.info(`[EmailService] Attempting to send email via SMTP to: ${to}`);
    const result = await transporter.sendMail({
      from: process.env.EMAIL_FROM || `"AQARIO Luxe" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    logger.info(`[EmailService] ✅ Email sent successfully via SMTP. Message ID: ${result.messageId}`);
    return result;
  } catch (error) {
    logger.error(`[EmailService] ❌ Failed to send email via SMTP: ${error.message}`);
    throw error;
  }
};

// ─── Email Verification ───────────────────────────────
exports.sendVerificationEmail = async (email, otp) => {
  const verifyURL = `${process.env.CLIENT_URL}/verify-email/${otp}`;

  await sendEmail({
    to: email,
    subject: 'Email Verification',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #eee;border-radius:8px">
        <h2 style="color:#1B3A5C">Verify Your Account</h2>
        <p>Welcome to our Real Estate Platform! Please click the button below to verify your email:</p>
        <a href="${verifyURL}" style="display:inline-block;padding:12px 28px;background:#28A745;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0;font-size:16px">
          Verify Email
        </a>
        <p style="font-size:14px;color:#555">Or use this OTP code: <strong>${otp}</strong></p>
        <p style="color:#888;font-size:13px">If you did not create an account, please ignore this email.</p>
      </div>
    `,
  });
};

// ─── Password Reset ────────────────────────────────
exports.sendPasswordResetEmail = async (email, resetToken) => {
  const resetURL = `${process.env.CLIENT_URL}/reset-password/${resetToken}`;
  await sendEmail({
    to: email,
    subject: 'Password Reset',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #eee;border-radius:8px">
        <h2 style="color:#1B3A5C">Reset Your Password</h2>
        <p>You requested a password reset. Click the button below:</p>
        <a href="${resetURL}" style="display:inline-block;padding:12px 28px;background:#2E75B6;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0;font-size:16px">
          Reset Password
        </a>
        <p style="color:#888;font-size:13px">This link is valid for 10 minutes only.</p>
        <p style="color:#888;font-size:13px">If you did not request this, please ignore this email.</p>
      </div>
    `,
  });
};

// ─── Booking Confirmation ──────────────────────────
exports.sendBookingConfirmationEmail = async (email, { propertyTitle, startDate, endDate, amount }) => {
  await sendEmail({
    to: email,
    subject: 'Booking Confirmation ✅',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #eee;border-radius:8px">
        <h2 style="color:#1A6B3A">Your booking is confirmed!</h2>
        <table style="width:100%;border-collapse:collapse;margin-top:16px">
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold">Property</td><td style="padding:8px;border:1px solid #ddd">${propertyTitle}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold">From</td><td style="padding:8px;border:1px solid #ddd">${new Date(startDate).toLocaleDateString('en-US')}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold">To</td><td style="padding:8px;border:1px solid #ddd">${new Date(endDate).toLocaleDateString('en-US')}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold">Amount</td><td style="padding:8px;border:1px solid #ddd">${amount} USD</td></tr>
        </table>
      </div>
    `,
  });
};

// ─── Viewing Approved — You Can Now Book ──────────────────
exports.sendViewingApprovedBookingEmail = async (email, { propertyTitle, preferredDate, preferredTime, status }) => {
  const isCompleted = status === 'completed';
  await sendEmail({
    to: email,
    subject: '✅ You Can Now Reserve This Property',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:32px;border:1px solid #e8e0d4;border-radius:12px;background:#fafaf8">
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:48px;margin-bottom:8px">🏠</div>
          <h2 style="color:#1a1a1a;font-family:Georgia,serif;font-weight:400;margin:0">Your Property Awaits</h2>
        </div>
        <p style="color:#555;font-size:15px;line-height:1.6">
          ${isCompleted ? 'Your viewing has been <strong>completed</strong>' : 'Your viewing request has been <strong>approved</strong>'}.
          You are now eligible to reserve <strong>${propertyTitle}</strong>.
        </p>
        <div style="background:#f5f0e8;border-left:3px solid #c9a96e;padding:16px;margin:20px 0;border-radius:4px">
          <p style="margin:0;color:#6b5a3e;font-size:14px">✨ You have exclusive access to reserve this property. This window may be time-sensitive.</p>
        </div>
        <div style="text-align:center;margin:28px 0">
          <a href="${process.env.CLIENT_URL}/properties" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#c9a96e,#a0783c);color:#fff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:600;letter-spacing:0.5px">
            View &amp; Reserve Property
          </a>
        </div>
        <p style="color:#aaa;font-size:12px;text-align:center;margin-top:24px">Aqario Luxe &mdash; Premium Real Estate Platform</p>
      </div>
    `,
  });
};

// ─── Viewing Request Response ─────────────────────
exports.sendViewingResponseEmail = async (email, { status, propertyTitle, preferredDate, preferredTime }) => {
  const isApproved = status === 'approved';
  await sendEmail({
    to: email,
    subject: isApproved ? 'Viewing Request Approved ✅' : 'Viewing Request Denied ❌',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #eee;border-radius:8px">
        <h2 style="color:${isApproved ? '#1A6B3A' : '#C0392B'}">
          ${isApproved ? '✅ Viewing Request Approved' : '❌ Viewing Request Denied'}
        </h2>
        <p>Regarding property: <strong>${propertyTitle}</strong></p>
        ${isApproved ? `
          <p>Scheduled date: <strong>${new Date(preferredDate).toLocaleDateString('en-US')}</strong> at <strong>${preferredTime}</strong></p>
          <p>Please arrive on time.</p>
        ` : '<p>Unfortunately, your request was denied. You may search for other properties.</p>'}
      </div>
    `,
  });
};

// ─── Property Submission Email Notification ────────
exports.sendPropertySubmissionNotificationEmail = async (details = {}) => {
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL || process.env.EMAIL_USER || 'eslam9076460@gmail.com';
  const { contactName, contactPhone, propertyType, listingType, city, notes, submittedAt } = details;

  try {
    logger.info(`[EmailService] Preparing property submission email notification for admin: ${adminEmail}`);

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #c5a059; border-radius: 12px; background-color: #141418; color: #ffffff; direction: rtl; text-align: right;">
        <h2 style="color: #c5a059; border-bottom: 1px solid rgba(197, 160, 89, 0.3); padding-bottom: 12px; margin-top: 0;">
          طلب جديد لإضافة عقار - AQARIO
        </h2>
        <p style="font-size: 15px; color: #d1d5db;">طلب جديد وصل من موقع AQARIO:</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #9ca3af; font-weight: bold; width: 35%;">اسم صاحب الطلب:</td>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #ffffff;">${contactName || 'عميل غير مسجل'}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #9ca3af; font-weight: bold;">رقم الهاتف:</td>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #60a5fa; direction: ltr; text-align: right;">${contactPhone || 'غير متوفر'}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #9ca3af; font-weight: bold;">نوع العقار:</td>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #ffffff;">${propertyType || 'عقار'}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #9ca3af; font-weight: bold;">نوع العرض:</td>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #ffffff;">${listingType || 'بيع'}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #9ca3af; font-weight: bold;">المدينة / المنطقة:</td>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #ffffff;">${city || 'قنا الجديدة'}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #9ca3af; font-weight: bold;">تاريخ الطلب:</td>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #ffffff;">${new Date(submittedAt || Date.now()).toLocaleString('ar-EG')}</td>
          </tr>
        </table>
        ${notes ? `
        <div style="margin-top: 20px; background-color: rgba(255,255,255,0.05); padding: 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);">
          <strong style="color: #c5a059; display: block; margin-bottom: 6px;">الملاحظات:</strong>
          <p style="margin: 0; color: #e5e7eb; font-size: 14px; line-height: 1.6;">${notes}</p>
        </div>` : ''}
        <div style="margin-top: 24px; text-align: center;">
          <a href="${process.env.CLIENT_URL || 'http://localhost:4200'}/admin/requests" style="display: inline-block; padding: 12px 24px; background-color: #c5a059; color: #000000; font-weight: bold; text-decoration: none; border-radius: 8px;">
            الانتقال إلى طلبات العقارات في لوحة التحكم
          </a>
        </div>
      </div>
    `;

    const result = await sendEmail({
      to: adminEmail,
      subject: `طلب جديد لإضافة عقار - AQARIO (${contactName || 'عميل'} - ${propertyType || 'عقار'})`,
      html: htmlContent
    });

    logger.info(`[EmailService] ✅ Property submission notification email sent successfully to ${adminEmail}`);
    return result;
  } catch (err) {
    logger.error(`[EmailService] ❌ Failed to send property request email to ${adminEmail}: ${err.message}`);
    return null;
  }
};
