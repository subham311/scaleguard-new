import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'support_emails.log');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Routes merchant inquiry directly to ScaleGuard support email (simulated via log file).
 * Triggers an automated confirmation receipt back to the merchant.
 * 
 * @param {object} params
 * @param {string} params.name - Merchant contact name
 * @param {string} params.email - Merchant email address
 * @param {string} params.subject - Support inquiry subject
 * @param {string} params.message - Detailed inquiry message
 * @param {string} params.shopDomain - Domain of the shop requesting support
 */
export async function sendSupportEmail({ name, email, subject, message, shopDomain }) {
  console.log(`[Email Service] Routing support inquiry to support@scaleguard.app`);
  console.log(`From: ${name} <${email}>`);
  console.log(`Shop: ${shopDomain}`);
  console.log(`Subject: ${subject}`);
  console.log(`Message: ${message}`);

  const logEntry = `
======================================================================
[${new Date().toISOString()}] SUPPORT INQUIRY ROUTED TO support@scaleguard.app
Shop Domain: ${shopDomain}
Merchant:    ${name} <${email}>
Subject:     ${subject}
Message:     
${message}
======================================================================
`;

  fs.appendFileSync(LOG_FILE, logEntry, 'utf8');

  // Send automated confirmation receipt
  await sendAutoConfirmation({ name, email });
  return true;
}

/**
 * Sends an automated confirmation receipt to the merchant.
 * 
 * @param {object} params
 * @param {string} params.name - Merchant name
 * @param {string} params.email - Merchant email address
 */
export async function sendAutoConfirmation({ name, email }) {
  const confirmationText = "We have received your enquiry and will get back to you within 48 hours.";
  
  console.log(`[Email Service] Sending auto-confirmation to ${name} <${email}>`);

  const logEntry = `
======================================================================
[${new Date().toISOString()}] AUTOMATED CONFIRMATION SENT TO MERCHANT
To:      ${name} <${email}>
From:    support@scaleguard.app
Subject: Automated Confirmation: Support Inquiry Received
Message:
${confirmationText}
======================================================================
`;

  fs.appendFileSync(LOG_FILE, logEntry, 'utf8');
  return true;
}
