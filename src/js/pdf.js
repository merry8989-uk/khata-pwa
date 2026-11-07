/**
 * PDF statement generation with jsPDF + AutoTable, vendored locally (see
 * scripts/build.mjs) so the export works with the network off.
 */

import { formatAmount } from './shared/money.js';
import { formatDate, formatDateTime, statementRows, summarize } from './shared/ledger.js';
import { t } from './i18n.js';

/**
 * jsPDF's built-in Helvetica is WinAnsi encoded and has no rupee glyph, so the
 * statement prints "Rs." the way the SMS template does instead of a broken box.
 */
function rs(paise) {
  return `Rs. ${formatAmount(paise)}`;
}

function libs() {
  const jsPDF = globalThis.jspdf?.jsPDF;
  if (!jsPDF) throw new Error('jsPDF is not loaded');
  return jsPDF;
}

/** Builds the jsPDF document without saving it (kept separate for tests). */
export function buildStatementDoc(customer, transactions, { shopName = '', now = new Date() } = {}) {
  const jsPDF = libs();
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const { given, got, net } = summarize(transactions);
  const rows = statementRows(transactions);

  // Header banner
  doc.setFillColor(30, 58, 138);
  doc.rect(0, 0, 210, 32, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text(t('statement.title'), 14, 18);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(t('statement.generated', { date: formatDateTime(now.toISOString()) }), 14, 25);
  if (shopName) {
    doc.setFontSize(9);
    doc.text(String(shopName).slice(0, 48), 150, 18, { align: 'left' });
  }

  // Customer block
  doc.setTextColor(33, 37, 41);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(t('statement.customer'), 14, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`${t('statement.name')}: ${customer.name}`, 14, 48);
  doc.text(`${t('statement.phone')}: ${customer.phone_number || 'N/A'}`, 14, 54);

  // Balance box
  doc.setFillColor(243, 244, 246);
  doc.roundedRect(118, 38, 78, 22, 2, 2, 'F');
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(100, 116, 139);
  doc.text(t('statement.totalBalance'), 122, 44);
  doc.setFontSize(13);
  if (net > 0) doc.setTextColor(220, 38, 38);
  else if (net < 0) doc.setTextColor(22, 163, 74);
  else doc.setTextColor(100, 116, 139);
  const netLabel = net > 0 ? t('balance.youGet') : net < 0 ? t('balance.youGive') : t('balance.settled');
  doc.text(`${rs(Math.abs(net))} (${netLabel})`, 122, 53);

  // Table
  const body = rows.map((row) => [
    String(row.index),
    row.date,
    row.note,
    row.type === 'GIVEN' ? rs(row.amount_paise) : '-',
    row.type === 'GOT' ? rs(row.amount_paise) : '-',
    `${rs(Math.abs(row.running_paise))} ${row.running_paise >= 0 ? t('balance.get') : t('balance.give')}`,
  ]);

  doc.autoTable({
    startY: 66,
    head: [
      [
        t('statement.colNum'),
        t('statement.colDate'),
        t('statement.colNote'),
        t('statement.colGave'),
        t('statement.colGot'),
        t('statement.colRunning'),
      ],
    ],
    body: body.length ? body : [['', '', t('ledger.empty.title'), '', '', '']],
    theme: 'grid',
    headStyles: { fillColor: [30, 58, 138], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
    columnStyles: {
      0: { cellWidth: 9, halign: 'center' },
      1: { cellWidth: 26 },
      2: { cellWidth: 57 },
      3: { cellWidth: 27, halign: 'right', textColor: [220, 38, 38] },
      4: { cellWidth: 27, halign: 'right', textColor: [22, 163, 74] },
      5: { cellWidth: 30, halign: 'right', fontStyle: 'bold' },
    },
    styles: { fontSize: 8.5, cellPadding: 2.6, overflow: 'linebreak' },
    alternateRowStyles: { fillColor: [249, 250, 251] },
    margin: { left: 14, right: 14, bottom: 20 },
  });

  const finalY = Math.min(doc.lastAutoTable.finalY + 9, 272);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(33, 37, 41);
  doc.text(`${t('statement.totalGave')}: ${rs(given)}`, 14, finalY);
  doc.text(`${t('statement.totalGot')}: ${rs(got)}`, 78, finalY);

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(156, 163, 175);
    doc.text(t('statement.footer'), 14, 290);
    doc.text(`${page} / ${pages}`, 196, 290, { align: 'right' });
  }

  return doc;
}

export function statementFileName(customer) {
  const safe = String(customer?.name || 'customer')
    .replace(/[^\w\u0900-\u097F -]+/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return `${safe || 'customer'}_Khata_Statement_${formatDate(new Date()).replace(/\s/g, '-')}.pdf`;
}

/** Generates and downloads the PDF. Returns the filename. */
export function downloadStatement(customer, transactions, options) {
  const doc = buildStatementDoc(customer, transactions, options);
  const name = statementFileName(customer);
  doc.save(name);
  return name;
}

/** Blob form, used by the smoke test and by "share statement". */
export function statementBlob(customer, transactions, options) {
  const doc = buildStatementDoc(customer, transactions, options);
  return doc.output('blob');
}
