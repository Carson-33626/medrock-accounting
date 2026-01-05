/**
 * Email notification utilities for AMY
 * Sends welcome emails to new users
 *
 * Brand Colors:
 * - Primary Purple: #5e3b8d
 * - Purple Dark: #402861
 * - Purple Light: #7b5ba8
 */

interface EmailData {
  to: string;
  subject: string;
  html: string;
}

/**
 * Send email notification
 * Uses Resend by default, can be configured for other providers
 */
export async function sendEmail(data: EmailData): Promise<boolean> {
  const emailProvider = process.env.EMAIL_PROVIDER || 'resend';
  console.log(`[Email] Using provider: ${emailProvider}`);

  try {
    if (emailProvider === 'resend') {
      return await sendViaResend(data);
    } else if (emailProvider === 'sendgrid') {
      return await sendViaSendGrid(data);
    } else {
      console.warn('No email provider configured, skipping email');
      return false;
    }
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

async function sendViaResend(data: EmailData): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATION_EMAIL_FROM || 'noreply@medrockpharmacy.com';

  if (!apiKey) {
    console.warn('RESEND_API_KEY not configured');
    return false;
  }

  console.log(`[Resend] Sending email to: ${data.to}, subject: "${data.subject}", from: ${from}`);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: data.to,
      subject: data.subject,
      html: data.html,
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error(`[Resend] API error (${response.status}):`, responseText);
    return false;
  }

  console.log(`[Resend] Email sent successfully:`, responseText);
  return true;
}

async function sendViaSendGrid(data: EmailData): Promise<boolean> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.NOTIFICATION_EMAIL_FROM || 'noreply@medrockpharmacy.com';

  if (!apiKey) {
    console.warn('[SendGrid] SENDGRID_API_KEY not configured');
    return false;
  }

  console.log(`[SendGrid] Sending email to: ${data.to}, subject: "${data.subject}", from: ${from}`);

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: data.to }] }],
      from: { email: from },
      subject: data.subject,
      content: [{ type: 'text/html', value: data.html }],
    }),
  });

  if (!response.ok) {
    console.error(`[SendGrid] API error (${response.status}):`, await response.text());
    return false;
  }

  console.log(`[SendGrid] Email sent successfully to ${data.to}`);
  return true;
}

// MedRock logo embedded as base64 to avoid email client blocking
const MEDROCK_LOGO_BASE64 = 'data:image/png;base64,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';

/**
 * Email wrapper/layout template for AMY
 */
function emailLayout(title: string, subtitle: string, content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f0f4f8;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #5e3b8d 0%, #7b5ba8 100%); padding: 30px 50px 35px 50px; border-radius: 16px 16px 0 0; text-align: center;">
              <img src="${MEDROCK_LOGO_BASE64}" alt="MedRock Pharmacy" width="180" height="58" style="display: block; margin: 0 auto 16px auto;">
              <h1 style="margin: 0; color: #ffffff; font-size: 26px; font-weight: 600;">${title}</h1>
              <p style="margin: 12px 0 0 0; color: #d4c4e8; font-size: 15px;">${subtitle}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; padding: 40px 50px;">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 25px 50px; border-radius: 0 0 16px 16px; border-top: 1px solid #e2e8f0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="text-align: center;">
                    <p style="margin: 0 0 8px 0; color: #5e3b8d; font-size: 14px; font-weight: 600;">MedRock Pharmacy</p>
                    <p style="margin: 0; color: #64748b; font-size: 12px;">AMY - Accounting Metrics & Yields</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

/**
 * Send welcome email to new user with their temporary password
 */
export async function sendWelcomeEmail(
  userEmail: string,
  fullName: string,
  tempPassword: string
): Promise<boolean> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://amy.medrockpharmacy.com';
  const authUrl = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.medrockpharmacy.com';
  const firstName = fullName.split(' ')[0];

  const content = `
    <p style="margin: 0 0 25px 0; color: #374151; font-size: 16px; line-height: 1.7;">
      Hi ${firstName}, welcome to the team! Your AMY account has been created and you're ready to start tracking accounting metrics and yields.
    </p>

    <!-- Welcome Hero Card -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 30px 0;">
      <tr>
        <td style="background: linear-gradient(135deg, #5e3b8d 0%, #7b5ba8 100%); border-radius: 12px; padding: 30px; text-align: center;">
          <div style="width: 64px; height: 64px; background-color: rgba(255,255,255,0.2); border-radius: 50%; margin: 0 auto 16px auto; line-height: 64px;">
            <span style="color: #ffffff; font-size: 32px;">&#10003;</span>
          </div>
          <p style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 700;">Account Ready</p>
          <p style="margin: 8px 0 0 0; color: #d4c4e8; font-size: 14px;">Your login credentials are below</p>
        </td>
      </tr>
    </table>

    <!-- Credentials Card -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 30px 0; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
      <tr>
        <td style="background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); padding: 14px 20px; border-bottom: 1px solid #e2e8f0;">
          <p style="margin: 0; color: #475569; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Login Credentials</p>
        </td>
      </tr>
      <tr>
        <td style="padding: 20px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td style="padding: 12px 0; border-bottom: 1px solid #f1f5f9;">
                <p style="margin: 0; color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Email Address</p>
                <p style="margin: 6px 0 0 0; color: #1e293b; font-size: 16px; font-weight: 600;">${userEmail}</p>
              </td>
            </tr>
            <tr>
              <td style="padding: 12px 0;">
                <p style="margin: 0; color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Temporary Password</p>
                <p style="margin: 6px 0 0 0; color: #1e293b; font-size: 18px; font-weight: 700; font-family: 'Courier New', monospace; background: linear-gradient(135deg, #f3e8ff 0%, #e9d5ff 100%); padding: 12px 16px; border-radius: 8px; display: inline-block; border: 1px solid #d8b4fe;">${tempPassword}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Quick Steps -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 30px 0;">
      <tr>
        <td style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 24px;">
          <p style="margin: 0 0 16px 0; color: #1e293b; font-size: 14px; font-weight: 700;">Getting Started:</p>
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              <td style="padding-bottom: 12px;">
                <table role="presentation" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align: top; padding-right: 12px;">
                      <div style="width: 24px; height: 24px; background: linear-gradient(135deg, #5e3b8d 0%, #7b5ba8 100%); border-radius: 50%; text-align: center; line-height: 24px; color: white; font-size: 12px; font-weight: 700;">1</div>
                    </td>
                    <td style="color: #475569; font-size: 14px; line-height: 24px;">Click the button below to log in</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom: 12px;">
                <table role="presentation" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align: top; padding-right: 12px;">
                      <div style="width: 24px; height: 24px; background: linear-gradient(135deg, #5e3b8d 0%, #7b5ba8 100%); border-radius: 50%; text-align: center; line-height: 24px; color: white; font-size: 12px; font-weight: 700;">2</div>
                    </td>
                    <td style="color: #475569; font-size: 14px; line-height: 24px;">Enter your email and temporary password</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td>
                <table role="presentation" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align: top; padding-right: 12px;">
                      <div style="width: 24px; height: 24px; background: linear-gradient(135deg, #5e3b8d 0%, #7b5ba8 100%); border-radius: 50%; text-align: center; line-height: 24px; color: white; font-size: 12px; font-weight: 700;">3</div>
                    </td>
                    <td style="color: #475569; font-size: 14px; line-height: 24px;">Create a new secure password when prompted</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- What is AMY section -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 30px 0;">
      <tr>
        <td style="background: linear-gradient(135deg, #f3e8ff 0%, #e9d5ff 100%); border: 1px solid #d8b4fe; border-radius: 10px; padding: 20px;">
          <p style="margin: 0 0 8px 0; color: #5e3b8d; font-size: 14px; font-weight: 700;">What is AMY?</p>
          <p style="margin: 0; color: #6b21a8; font-size: 13px; line-height: 1.6;">
            AMY (Accounting Metrics & Yields) is MedRock's internal dashboard for tracking coupon analytics, financial metrics, and accounting data. Use it to monitor coupon usage, generate reports, and analyze pharmacy performance.
          </p>
        </td>
      </tr>
    </table>

    <!-- Security Notice -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 30px 0;">
      <tr>
        <td style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 1px solid #f59e0b; border-radius: 10px; padding: 18px 20px;">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              <td style="vertical-align: top; padding-right: 14px;">
                <div style="width: 32px; height: 32px; background-color: #f59e0b; border-radius: 50%; text-align: center; line-height: 32px;">
                  <span style="color: white; font-size: 18px;">!</span>
                </div>
              </td>
              <td>
                <p style="margin: 0 0 4px 0; color: #92400e; font-size: 14px; font-weight: 700;">Security Notice</p>
                <p style="margin: 0; color: #a16207; font-size: 13px; line-height: 1.5;">You'll be required to change your password on first login. Please choose a strong password with at least 8 characters.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- CTA Button -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 30px 0;">
      <tr>
        <td align="center">
          <a href="${authUrl}/login?redirect=${encodeURIComponent(appUrl)}" style="display: inline-block; background: linear-gradient(135deg, #5e3b8d 0%, #7b5ba8 100%); color: #ffffff; text-decoration: none; padding: 16px 44px; border-radius: 8px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 14px rgba(94, 59, 141, 0.35);">
            Log In to AMY
          </a>
        </td>
      </tr>
    </table>

    <p style="margin: 25px 0 0 0; color: #64748b; font-size: 13px; line-height: 1.6; text-align: center;">
      If you did not expect this email, please contact your administrator.
    </p>
  `;

  const html = emailLayout(
    'Welcome to AMY',
    'Your account has been created',
    content
  );

  return sendEmail({
    to: userEmail,
    subject: 'Welcome to AMY - Your Account is Ready',
    html,
  });
}
