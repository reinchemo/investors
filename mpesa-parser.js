
// ============================================================
// STARLINK LLC — M-PESA / Bank SMS Parser (Items 6 & 7)
// ============================================================

/**
 * Parses a raw M-PESA or Bank SMS string and extracts transaction details.
 * Returns an object with the extracted fields and a confidence score.
 */
function parseFinancialMessage(rawText) {
    if (!rawText || typeof rawText !== 'string') {
        return { success: false, error: 'No message provided' };
    }

    const text = rawText.replace(/\r?\n|\r/g, ' ').trim();
    const result = {
        success: false,
        raw_message: text,
        reference: null,
        amount: 0,
        fee: 0,
        txn_date: null,
        txn_time: null,
        sender: null,
        recipient: null,
        phone: null,
        type: 'expense', // default
        confidence: 'low'
    };

    try {
        // ---------------------------------------------------------
        // 1. SAFARICOM M-PESA (Send Money / Paybill / Buy Goods)
        // Example: QAB1XYZ2 Confirmed. Ksh1,500.00 sent to JOHN DOE 0712345678 on 3/10/26 at 2:22 PM. Transaction cost, Ksh0.00.
        // ---------------------------------------------------------
        if (text.includes('Confirmed.') && (text.includes('Ksh') || text.includes('Ksh.'))) {

            // Extract Reference (Usually the first word)
            const refMatch = text.match(/^([A-Z0-9]{10})\s+Confirmed/i);
            if (refMatch) result.reference = refMatch[1];

            // Extract Amount
            const amtMatch = text.match(/Ksh([\d,]+\.\d{2})/i);
            if (amtMatch) result.amount = parseFloat(amtMatch[1].replace(/,/g, ''));

            // Extract Fee (Transaction cost)
            const feeMatch = text.match(/Transaction cost,?\s*Ksh([\d,]+\.\d{2})/i);
            if (feeMatch) result.fee = parseFloat(feeMatch[1].replace(/,/g, ''));

            // Extract Date & Time
            const dateMatch = text.match(/on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
            if (dateMatch) {
                // Convert DD/MM/YY to YYYY-MM-DD
                const parts = dateMatch[1].split('/');
                let year = parts[2];
                if (year.length === 2) year = '20' + year; // Assume 20xx
                const month = parts[1].padStart(2, '0');
                const day = parts[0].padStart(2, '0');
                result.txn_date = `${year}-${month}-${day}`;

                // Convert Time to 24h format
                const timeParts = dateMatch[2].match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
                if (timeParts) {
                    let hours = parseInt(timeParts[1], 10);
                    const mins = timeParts[2];
                    const ampm = timeParts[3].toUpperCase();
                    if (ampm === 'PM' && hours < 12) hours += 12;
                    if (ampm === 'AM' && hours === 12) hours = 0;
                    result.txn_time = `${hours.toString().padStart(2, '0')}:${mins}:00`;
                }
            }

            // Extract Recipient & Phone
            const recMatch = text.match(/sent to\s+([A-Za-z\s]+)\s+(\d{10})/i);
            if (recMatch) {
                result.recipient = recMatch[1].trim();
                result.phone = recMatch[2];
            }

            // Determine Type (Income vs Expense)
            if (text.includes('received from')) {
                result.type = 'income';
                const senderMatch = text.match(/received from\s+([A-Za-z\s]+)\s+(\d{10})/i);
                if (senderMatch) {
                    result.sender = senderMatch[1].trim();
                    result.phone = senderMatch[2];
                }
            }

            result.confidence = 'high';
            result.success = true;
        }

        // ---------------------------------------------------------
        // 2. EQUITY BANK / KCB / NCBA (Generic pattern)
        // Example: Your A/C 123456789 has been credited with KES 5,000.00 on 03/10/2026. Ref: EQX123456.
        // ---------------------------------------------------------
        else if (text.match(/(credited|debited)\s+with/i)) {
            const amtMatch = text.match(/(?:KES|Ksh|Ksh\.)\s*([\d,]+\.\d{2})/i);
            if (amtMatch) result.amount = parseFloat(amtMatch[1].replace(/,/g, ''));

            const refMatch = text.match(/Ref:\s*([A-Z0-9]+)/i);
            if (refMatch) result.reference = refMatch[1];

            const dateMatch = text.match(/on\s+(\d{2}\/\d{2}\/\d{4})/i);
            if (dateMatch) {
                const parts = dateMatch[1].split('/');
                result.txn_date = `${parts[2]}-${parts[1]}-${parts[0]}`; // DD/MM/YYYY to YYYY-MM-DD
            }

            result.type = text.includes('credited') ? 'income' : 'expense';
            result.confidence = 'medium';
            result.success = true;
        }

        return result;

    } catch (err) {
        console.error("Parse error:", err);
        return { success: false, error: err.message, raw_message: text };
    }
}
