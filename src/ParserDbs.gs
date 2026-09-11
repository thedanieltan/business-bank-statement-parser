/**
 * ParserDbs.gs
 * -----------------------------------------------------------------------
 * Deterministic parser for DBS Business "Account Statement" PDFs, written
 * against how Google Drive OCR renders the current layout.
 *
 * Visual columns: Transaction Date | Value Date | Transaction Details |
 * Withdrawal | Deposit | Balance. OCR flattens each transaction into a
 * jumbled block, e.g.:
 *
 *   Balance Brought Forward 0.00
 *   04-May-26 1,632.00                         <- value date + BALANCE
 *   04-May-26 FAST PAYMENT 2660DBS 1,632.00    <- txn date + details + amount
 *   20260504ANTPSGSGBRT0064491 OTHER           <- continuation
 *   SOME COMPANY PTE. LTD.                      <- counterparty (continuation)
 *   20260504ANTPSGSGBRT0064491 SGD 1632        <- continuation
 *   ...
 *   30-May-26 30-May-26 ADVICE ADV MONTHLY ACCOUNT FEE 10.00 1,832.00  <- combined
 *   Total ... Balance Carried Forward
 *
 * Rather than trust the jumbled Withdrawal/Deposit columns, DIRECTION and
 * AMOUNT are derived from the running BALANCE: balance up = deposit
 * (incoming), balance down = withdrawal (outgoing), amount = |delta|. Each
 * transaction contributes exactly one running balance and one description, in
 * order, so the two are zipped by index.
 *
 * Only the SGD section is parsed. PAYER/PAYEE + TYPE are left mostly to
 * guessType and to your own downstream logic, since what a given account is
 * used FOR (loan repayments, operating expenses, intra-company transfers...)
 * is specific to each business, not to DBS's statement format.
 *
 * NOTE ON PAGE-HEADER NOISE: like most bank statements, DBS repeats the
 * account holder's own registered address as running header/footer text.
 * That text is account-holder-specific, so it isn't hardcoded here -- if you
 * see your own company's address leaking into transaction descriptions, add
 * it to the _NOISE list below (see the comment there).
 * -----------------------------------------------------------------------
 */

const ParserDbs = {

  BANK_NAME: 'DBS',

  _DATE: '\\d{1,2}-[A-Za-z]{3}-\\d{2,4}',   // "04-May-26" or "01-May-2026"
  _AMOUNT: /^[\d,]+\.\d{2}$/,

  detect: function (text) {
    return /DBS\s*Bank/i.test(text) && /Account Statement/i.test(text);
  },

  parse: function (text) {
    const accountNumber = this._extractAccountNumber(text);
    const period = this._extractStatementPeriod(text);
    const res = this._extractTransactions(this._isolateSGD(text));

    let closingBalance = null;
    for (let i = res.transactions.length - 1; i >= 0; i--) {
      if (res.transactions[i].balance !== null) { closingBalance = res.transactions[i].balance; break; }
    }

    // Opening balance fallback (if "Balance Brought Forward" wasn't captured):
    // derive from the first transaction's running balance.
    let openingBalance = res.openingBalance;
    if (openingBalance === null && res.transactions.length) {
      const t0 = res.transactions[0];
      if (t0.balance !== null) {
        openingBalance = t0.balance - (t0.incoming || 0) + (t0.outgoing || 0);
      }
    }

    const statement = {
      bank: this.BANK_NAME,
      accountNumber: accountNumber,
      statementPeriod: period,
      openingBalance: openingBalance,
      closingBalance: closingBalance,
      transactions: res.transactions
    };
    // Tally check (see BalanceCheck.gs): does opening + sum(transactions)
    // equal closing, and does each row's own printed balance agree with the
    // running total? A false result almost always means a row was
    // mis-parsed or dropped -- check this before trusting the output.
    statement.balanceCheck = validateStatementBalance(statement);
    return statement;
  },

  // -----------------------------------------------------------------------

  _extractAccountNumber: function (text) {
    const m = text.match(/Account\s*No\.?\s*[:：]?\s*([\d\-]{6,})/i);
    return m ? m[1].replace(/\D/g, '') : null;
  },

  _extractStatementPeriod: function (text) {
    const d = '(\\d{1,2}-[A-Za-z]{3}-\\d{2,4})';
    const m = text.match(new RegExp(d + '\\s+to\\s+' + d, 'i'));
    if (!m) return { start: null, end: null };
    return { start: this._parseDate(m[1]), end: this._parseDate(m[2]) };
  },

  _parseDate: function (str) {
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const m = String(str).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (!m) return null;
    const month = months[m[2].toUpperCase()];
    if (month === undefined) return null;
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    return new Date(year, month, parseInt(m[1], 10));
  },

  _isolateSGD: function (text) {
    const lines = text.split('\n').map(function (l) { return l.trim(); });
    let start = -1, end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (start === -1 && /Currency\s*:?\s*SGD/i.test(lines[i])) { start = i; continue; }
      if (start !== -1 && /Currency\s*:?\s*(USD|CNH|EUR|GBP|AUD|JPY|HKD|CNY|RMB)/i.test(lines[i])) { end = i; break; }
      if (start !== -1 && /Balance Carried Forward/i.test(lines[i])) { end = i + 1; break; }
    }
    if (start === -1) return text;
    return lines.slice(start, end).join('\n');
  },

  // Footer / message / header furniture to drop entirely. Add your own
  // company name/address here if it repeats as page-header noise in your
  // statements (see the note at the top of this file).
  _NOISE: [
    /^DBS\s*Bank/i, /Marina Boulevard/i, /dbs\.com/i, /^Account Statement/i,
    /^Details Of Your DBS/i, /^Page\s*\d+\s*of\s*\d+/i,
    /^SINGAPORE\s+\d/i, /^#\d+-\d+/i, /^Currency\s*:/i,
    /Transaction\s*Details/i, /^Withdrawal/i, /Value\s*Date/i, /^Date\s+Balance/i,
    /^Messages For You/i, /Discontinuation of/i, /Corporate ATM/i, /Cessation of/i,
    /go\.dbs\.com/i, /DEPOSIT INSURANCE/i, /^PLEASE (CHECK|NOTIFY)/i,
    /ALL TRANSACTIONS DONE/i, /OVERDRAFT INTEREST/i, /AMOUNT OVERDRAWN/i,
    /OVERDRAFT AMOUNT/i, /CR BALANCES/i, /BusinessCare/i, /^For any queries/i,
    /^Continue on the next page/i, /^•/, /INTEREST COMPUTATION/i, /CLEARING DAY/i,
    /FOREIGN CURRENCY DEPOSITS/i, /SUPPLEMENTARY RETIREMENT/i
  ],

  // Strip mid-line footer text OCR appended to a transaction line.
  _stripInline: function (s) {
    return s.replace(/\s*Co\.\s*Reg\.\s*No\..*$/i, '')
            .replace(/\s*GST\s*Reg\s*No.*$/i, '');
  },

  _extractTransactions: function (sgdText) {
    const self = this;
    const dateRe = new RegExp('^(' + this._DATE + ')\\s+(.*)$');
    const twoDateRe = new RegExp('^(' + this._DATE + ')\\s+(' + this._DATE + ')\\s+(.*)$');

    const lines = sgdText.split('\n').map(function (l) { return self._stripInline(l.trim()); })
      .filter(function (l) { return l.length > 0; })
      .filter(function (l) {
        for (let k = 0; k < self._NOISE.length; k++) { if (self._NOISE[k].test(l)) return false; }
        return true;
      });

    let openingBalance = null;
    const balances = [];   // running balance after each txn, in order
    const entries = [];    // { date, descTokens: [], printedAmount }, in order

    lines.forEach(function (line) {
      if (/Balance Brought Forward/i.test(line)) {
        const m = line.match(/([\d,]+\.\d{2})/);
        if (m) openingBalance = self._toNumber(m[1]);
        return;
      }
      if (/Balance Carried Forward/i.test(line) || /^Total\b/i.test(line)) return;

      const two = line.match(twoDateRe);
      if (two) {
        // Combined line: txnDate valueDate details <amount> <balance>
        const amts = (two[3].match(/[\d,]+\.\d{2}/g) || []);
        const balance = amts.length ? self._toNumber(amts[amts.length - 1]) : null;
        const desc = two[3].replace(/[\d,]+\.\d{2}/g, ' ').replace(/\s+/g, ' ').trim();
        entries.push({
          date: self._parseDate(two[1]),
          descTokens: [desc],
          printedAmount: amts.length > 1 ? self._toNumber(amts[amts.length - 2]) : null
        });
        if (balance !== null) balances.push(balance);
        return;
      }

      const one = line.match(dateRe);
      if (one) {
        const rest = one[2].trim();
        if (self._AMOUNT.test(rest)) {           // balance-only line
          balances.push(self._toNumber(rest));
          return;
        }
        // Detail line: date + text + trailing amount (amount ignored; the
        // running balance drives amount/direction).
        const printed = rest.match(/([\d,]+\.\d{2})\s*$/);
        const desc = rest.replace(/[\d,]+\.\d{2}\s*$/, '').replace(/\s+/g, ' ').trim();
        entries.push({
          date: self._parseDate(one[1]),
          descTokens: [desc],
          printedAmount: printed ? self._toNumber(printed[1]) : null
        });
        return;
      }

      // Continuation line -- append to the current transaction's description.
      if (entries.length) entries[entries.length - 1].descTokens.push(line);
    });

    const transactions = [];
    const n = Math.min(entries.length, balances.length);
    let prev = (openingBalance !== null) ? openingBalance : 0;
    for (let i = 0; i < n; i++) {
      const balance = balances[i];
      const delta = balance - prev;
      const incoming = delta > 0;
      const amount = Math.abs(delta);
      const description = entries[i].descTokens.join(' ').replace(/\s+/g, ' ').trim();
      const transaction = {
        date: entries[i].date,
        description: description,
        outgoing: incoming ? null : amount,
        incoming: incoming ? amount : null,
        balance: balance,
        payerPayee: this._extractCounterparty(description),
        printedAmount: entries[i].printedAmount
      };
      if (amount === 0) {
        transaction.parseWarning = 'Zero-value financial transaction';
      } else if (entries[i].printedAmount !== null &&
                 Math.abs(entries[i].printedAmount - amount) >= 0.005) {
        transaction.parseWarning = 'Printed amount ' + entries[i].printedAmount.toFixed(2) +
          ' does not match running-balance movement ' + amount.toFixed(2);
      }
      transactions.push(transaction);
      prev = balance;
    }

    if (entries.length !== balances.length && transactions.length > 0) {
      transactions[transactions.length - 1].parseWarning =
        'Row/balance mismatch: ' + entries.length + ' detail rows vs ' + balances.length + ' balances';
    }

    return { openingBalance: openingBalance, transactions: transactions };
  },

  /**
   * DBS descriptions carry the counterparty as a standalone chunk (e.g.
   * "SOME COMPANY PTE. LTD."). Direction (payer vs payee) is left to your own
   * logic, so we only surface an obvious company name here.
   */
  _extractCounterparty: function (description) {
    const m = String(description || '').match(/\b([A-Z][A-Za-z0-9&.,'\- ]+?PTE\.?\s*LTD\.?)/);
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  },

  _toNumber: function (str) {
    if (str === null || str === undefined) return null;
    const c = String(str).replace(/,/g, '').trim();
    if (c === '' || c === '-') return null;
    const n = parseFloat(c);
    return isNaN(n) ? null : n;
  },

  /**
   * Optional lightweight categorization hint, based purely on wording that
   * the bank itself prints (interest / fee lines) -- nothing account- or
   * business-specific. Everything else is left uncategorized ('') for
   * manual/your-own categorization: what a given DBS account is used for
   * (operating account, loan servicing, intra-company float, etc.) is a
   * business-specific fact this parser has no way to know, unlike the
   * ANEXT parser's interest/fee detection which is printed on the
   * statement itself.
   */
  guessType: function (transaction) {
    const desc = (transaction.description || '').toUpperCase();
    const incoming = transaction.incoming !== null;

    if (incoming && /INTEREST/.test(desc)) {
      transaction.payerPayee = this.BANK_NAME;
      return 'BANK INTEREST';
    }
    if (/(MONTHLY ACCOUNT FEE|ACCOUNT FEE|SERVICE CHARGE|SERVICE FEE|FALL BELOW FEE|ADMIN FEE|BANK CHARGE)/.test(desc)) {
      transaction.payerPayee = this.BANK_NAME;
      return 'BANK CHARGES';
    }
    return '';
  }
};
