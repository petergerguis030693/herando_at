const fs   = require('fs');
const path = require('path');
const db = require('../db');
const { PDFDocument, StandardFonts } = require('pdf-lib');

async function generateInvoice(order, callback) {
  const locale = (order.locale || 'de').split('-')[0];

  const tPdf = async (key) => {
    try {
      const [[row]] = await db.query(
        `SELECT ?? AS txt FROM ui_translations WHERE \`key\` = ? LIMIT 1`,
        [locale, key]
      );
      return row?.txt || key;
    } catch {
      return key;
    }
  };

  try {
    // Hilfsfunktionen
    const asText = v => v == null ? '' : String(v);
    const asEuro = n => {
      const num = typeof n === 'number' ? n : Number(n) || 0;
      return num.toFixed(2).replace('.', ',') + ' €';
    };

    // Vorlage laden
    let relPath = (process.env.INVOICE_TEMPLATE_PATH || 'public/assets/pdf/vorlage.pdf').trim();
    if (!relPath.startsWith('public/')) relPath = `public/${relPath}`;
    const templatePath     = path.resolve(process.cwd(), relPath);
    const existingPdfBytes = fs.readFileSync(templatePath);

    // PDF initialisieren
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    pdfDoc.setTitle('Herando Rechnung');
    pdfDoc.setSubject('Rechnung');
    pdfDoc.setAuthor('Herando');
    pdfDoc.setCreator('Herando Invoice Service');
    pdfDoc.setProducer('Herando');
    const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const [page] = pdfDoc.getPages();

    // Layout-Positionen (NICHT geändert)
    const pageWidth   = page.getWidth();
    const labelX      = pageWidth - 200;
    const valueX      = labelX + 110;
    const baseY       = 672;
    const lineSpacing = 10;
    const recipientX  = 20 + 56; // ca. 2cm eingerückt

    // 🔹 Steuerberechnung: NETTO-Werte (Rabatt support)
    const originalNet   = Number(order.original_net) || Number(order.amount) || 0;
    const discountPct   = Number(order.discount_percent) || 0;
    const discountValue = Number(order.discount_amount) || 0;
    const netAmount     = Number(order.net_after_discount) || originalNet;

    // Standardsteuer 21 %
    let taxPercent = 21;
    let applyVat = true;

    // ISO-Code Land
    const countryCode = (order.partner_abbreviation || '').toUpperCase();
    const euCountries = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
    const vatid = order.partner_atu_nummer || '';

    // Steuerlogik
    if (vatid && vatid.trim() !== '') {
      if (countryCode === 'CZ' || countryCode === 'AT') {
        applyVat = true; taxPercent = 21;
      } else if (euCountries.includes(countryCode)) {
        applyVat = false; taxPercent = 0;
      } else {
        applyVat = false; taxPercent = 0;
      }
    } else {
      applyVat = true; taxPercent = 21;
    }

    const taxAmount   = applyVat ? netAmount * (taxPercent / 100) : 0;
    const grossAmount = netAmount + taxAmount;
    const totalAmount = grossAmount;

    // Rechnungsdatum
    page.drawText((await tPdf('invoice.date')) + ':', { x: labelX + 12.5, y: baseY, size: 8, font });
    page.drawText(
      new Date().toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' }),
      { x: valueX, y: baseY, size: 8, font }
    );

    // Kundennummer
    const customerY = baseY - lineSpacing;
    page.drawText((await tPdf('invoice.customer_number')) + ':', { x: labelX + 12.5, y: customerY, size: 8, font });
    page.drawText(asText(order.partner_partnerident), { x: valueX, y: customerY, size: 8, font });

    // USt-IdNr.
    if (order.partner_atu_nummer) {
      const ustY = customerY - lineSpacing;
      page.drawText((await tPdf('invoice.vat_number')) + ':', { x: labelX + 12.5, y: ustY, size: 8, font });
      page.drawText(asText(order.partner_atu_nummer), { x: valueX, y: ustY, size: 8, font });
    }

    // Empfängeradresse
    let recipientY = baseY;

    function drawLine(text) {
      if (!text || String(text).trim() === '') return;
      page.drawText(text, { x: recipientX, y: recipientY, size: 10, font });
      recipientY -= 13;
    }

    // Reihenfolge bleibt gleich, aber nur wenn Inhalt da ist
    drawLine(`${asText(order.partner_first_name)} ${asText(order.partner_last_name)}`);
    drawLine(asText(order.partner_firmenname));
    drawLine(asText(order.partner_address));
    drawLine(asText(order.partner_city));
    drawLine(asText(order.partner_country));


    // Rechnungsnummer & Anrede
    recipientY -= 70;
    const invLine = (await tPdf('invoice.invoice_number')).replace('{{number}}', order.invoice_code);
    const orderRef = (await tPdf('invoice.order_id')).replace('{{id}}', order.order_id_txt);

    page.drawText(`${invLine} (${orderRef})`, { x: recipientX, y: recipientY, size: 14, font });

    recipientY -= 35;
    page.drawText(
      (await tPdf('invoice.salutation'))
        .replace('{{firstname}}', asText(order.partner_first_name))
        .replace('{{lastname}}', asText(order.partner_last_name)),
      { x: recipientX, y: recipientY, size: 11, font }
    );

    // Einleitungstext
    recipientY -= 20;
    page.drawText(await tPdf('invoice.intro'), { x: recipientX, y: recipientY, size: 11, font });

    // Tabellenkopf
    recipientY -= 50;
    page.drawText(await tPdf('invoice.column.article'), { x: recipientX, y: recipientY, size: 9, font });

    // ================== POSITION / RABATT (FIX) ==================
    const packageName = await tPdf(order.package_key);
    const entityName  = await tPdf(order.entity_key);

    const packageLine = (await tPdf(order.ad_key))
      .replace('{{package}}', packageName)
      .replace('{{entity}}', entityName);

    const runtimeLine = order.package_end_formatted
      ? (await tPdf('invoice.runtime')).replace('{{date}}', order.package_end_formatted)
      : '';

    // Spalten-Positionen
    const PRICE_X       = recipientX + 200;
    const QTY_CENTER_X  = recipientX + 280;
    const SUM_RIGHT_X   = recipientX + 400 + 42;

    const fontSizePos = 9;

    function drawRight(text, rightX, y) {
      const w = font.widthOfTextAtSize(text, fontSizePos);
      page.drawText(text, { x: rightX - w, y, size: fontSizePos, font });
    }

    function drawCenter(text, centerX, y) {
      const w = font.widthOfTextAtSize(text, fontSizePos);
      page.drawText(text, { x: centerX - w / 2, y, size: fontSizePos, font });
    }

    function drawLabel(text, y, size = fontSizePos) {
      page.drawText(text, { x: recipientX, y, size, font });
    }

    page.drawText(await tPdf('invoice.column.price'), { x: PRICE_X, y: recipientY, size: 9, font });
    drawCenter(await tPdf('invoice.column.qty'), QTY_CENTER_X, recipientY);
    drawRight(await tPdf('invoice.column.total'), SUM_RIGHT_X, recipientY);

    // Einzelposition
    recipientY -= 15;

    // Artikel
    drawLabel(packageLine, recipientY, 9);

    // Laufzeit UNTER Artikel
    if (runtimeLine) {
      recipientY -= 12;
      drawLabel(runtimeLine, recipientY, 8);
      recipientY += 12; // zurück auf Artikel-Linie
    }

    // Preis/Menge/Summe (links/zentriert/rechts auf Artikel-Linie)
    page.drawText(asEuro(originalNet), { x: PRICE_X, y: recipientY, size: fontSizePos, font });
    drawCenter('1', QTY_CENTER_X, recipientY);
    drawRight(asEuro(originalNet), SUM_RIGHT_X, recipientY);

    // ⭐⭐⭐ WICHTIG: GROSSER Abstand bevor Rabatt kommt
    recipientY -= 26;

    if (discountPct > 0) {
      drawLabel(`Rabatt (${discountPct}%)`, recipientY, 9);
      drawRight(`- ${asEuro(discountValue)}`, SUM_RIGHT_X, recipientY);

      recipientY -= 16;

      drawLabel(`Neue Zwischensumme`, recipientY, 9);
      drawRight(asEuro(netAmount), SUM_RIGHT_X, recipientY);
    }

    // ================== /POSITION / RABATT ==================

    // Totals-Block rechts unten (Layout NICHT geändert)
    const TOTAL_RIGHT_X = recipientX + 400 + 42;
    const fontSizeTotals = 10;
    const gap = 8;

    const labels = [
      await tPdf('invoice.subtotal'),
      (await tPdf('invoice.tax')).replace('{{percent}}', taxPercent),
      await tPdf('invoice.total')
    ];

    const values = [
      asEuro(netAmount),
      asEuro(taxAmount),
      asEuro(totalAmount)
    ];

    const yPositions = [360, 345, 330];

    for (let i = 0; i < labels.length; i++) {
      const valueWidth = font.widthOfTextAtSize(values[i], fontSizeTotals);
      const valueX = TOTAL_RIGHT_X - valueWidth;

      page.drawText(values[i], {
        x: valueX,
        y: yPositions[i],
        size: fontSizeTotals,
        font
      });

      const labelWidth = font.widthOfTextAtSize(labels[i], fontSizeTotals);
      const labelX = valueX - gap - labelWidth;

      page.drawText(labels[i], {
        x: labelX,
        y: yPositions[i],
        size: fontSizeTotals,
        font
      });
    }

    // Info-Block (Layout NICHT geändert)
    const infoStartY = 305;
    const infoGap = 14;

    let paymentText = '';
    let paymentNote = '';

    if (order.payment_status === 'failed') {
      paymentText = await tPdf('invoice.payment.failed');
      paymentNote = await tPdf('invoice.payment.please_pay');
    } else {
      paymentText = await tPdf('invoice.payment.paid');
      paymentNote = await tPdf('invoice.payment.via_stripe'); // Key lassen wie du es hast
    }

    let vatNoteText = '';
    if (!applyVat && taxPercent === 0) vatNoteText = await tPdf('invoice.reverse_charge');
    else if (!applyVat) vatNoteText = await tPdf('invoice.tax_free');

    page.drawText(vatNoteText, { x: 80, y: infoStartY, size: 9, font });
    page.drawText(paymentText, { x: 80, y: infoStartY - infoGap, size: 9, font });
    page.drawText(paymentNote, { x: 80, y: infoStartY - infoGap * 2, size: 9, font });

    // PDF speichern
    const pdfBytes = await pdfDoc.save();
    callback(null, pdfBytes);

  } catch (err) {
    callback(err);
  }
}

module.exports = { generateInvoice };
