/**
 * ParserAnext.gs
 * -----------------------------------------------------------------------
 * Deterministic parser for ANEXT Bank Business "Account Statement" PDFs,
 * written against how GOOGLE DRIVE OCR actually renders the current (2026)
 * layout
 * -- which differs from the visual PDF:
 *
 *   - Short rows are inline and several may share one OCR line:
 *       "01 May 2026 Balance Brought Forward 1,711.90 01 May 2026
 *        Interest Earned - 0.04 1,711.94 01 May 2026 Interest Earned ..."
 *   - Long rows (FAST/GIRO transfers) put their date+description on their
 *     own line WITHOUT amounts, and the amounts for that whole block are
 *     collected onto a following line, in transaction order:
 *       "01 May 2026 Incoming FAST Transfer From X (Account Ending 5907)"
 *       "01 May 2026 Outgoing FAST Transfer to Y (Account Ending 2001)"
 *       "- 9,750.00 11,462.06 2,610.30 - 8,851.76 ..."
 *
 * Because OCR preserves transaction order in BOTH the description stream and
 * the amount stream, we collect the two as ordered lists and zip them:
 * transaction i = (i-th date+description) + (i-th [Debit, Credit, Balance]).
 *
 * Other facts:
 *   - Dates: "DD Mon YYYY" (legacy "DD-MON-YYYY" also parsed).
 *   - Debit = money out, Credit = money in; unused column prints "-".
 *   - "Balance Brought Forward" = opening; each currency has a "Total" row.
 *   - Multiple currency sections (SGD, USD, CNH, EUR); only SGD is parsed
 *     here -- add more currency codes to _isolateSGD/_NOISE if you need
 *     another section.
 *   - PAYER/PAYEE is embedded as "... From/to <name> (Account Ending ####)".
 *
 * NOTE ON PAGE-HEADER NOISE: multi-page statements repeat the account
 * holder's own name/address as running header text on every OCR "page"
 * block. That text is account-holder-specific, so it isn't hardcoded here
 * -- if you see your own company name/address leaking into transaction
 * descriptions, add it to the _NOISE list below (see the comment there).
 * -----------------------------------------------------------------------
 */

const ParserAnext = {

  BANK_NAME: 'ANEXT',

  _DATE: '\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4}', // "01 May 2026"
  _AMOUNT: /^(-|[\d,]+\.\d{2})$/,

  detect: function (text) {
    return /ANEXT/i.test(text) && /Account Statement/i.test(text);
  },

  parse: function (text) {
    const accountNumber = this._extractAccountNumber(text);
    const period = this._extractStatementPeriod(text);
    const sgd = this._isolateSGD(text);

    // NEW layout (2026+) has an "Account Summary" block and a "Daily Balance"
    // column with amounts split one-per-line; the OLDER layout has a per-row
    // Balance column. Route to the matching extractor.
    const isNew = /Account Summary/i.test(text) || /Daily\s+Balance/i.test(text);
    const res = isNew ? this._extractNewFormat(sgd) : this._extractTransactions(sgd);

    // Closing balance: new layout takes it from the Account Summary; old
    // layout uses the last transaction's running balance.
    let closingBalance = (res.closingBalance !== undefined && res.closingBalance !== null)
      ? res.closingBalance : null;
    if (closingBalance === null) {
      for (let i = res.transactions.length - 1; i >= 0; i--) {
        if (res.transactions[i].balance !== null) { closingBalance = res.transactions[i].balance; break; }
      }
    }

    // Opening fallback (old layout): if "Balance Brought Forward" wasn't
    // captured, derive it from the first transaction's running balance. The
    // new layout reads Opening Balance directly from the summary.
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

  /**
   * Extractor for the NEW ANEXT layout (Account Summary + Daily Balance).
   *   - Opening & Closing come from the Account Summary (authoritative).
   *   - Each transaction shows only Debit + Credit (one is "-"); balances are
   *     daily, shown intermittently and ignored here.
   *   - OCR puts each transaction's amounts on their OWN line; for grouped
   *     transfers the descriptions come first, then one amount line each, then
   *     a lone daily-balance line. So we pair descriptions (in order) with the
   *     amount lines that contain a "-" (a lone number line = daily balance).
   * Validation later reconciles opening + Σ(credit-debit) against closing.
   */
  _extractNewFormat: function (sgdText) {
    const self = this;
    const AMT = /^(-|[\d,]+\.\d{2})$/;
    const dateHead = new RegExp('^(' + this._DATE + ')\\s+(.*)$');

    let openingBalance = null, closingBalance = null;
    const om = sgdText.match(/Opening Balance\s+([\d,]+\.\d{2})/i);
    if (om) openingBalance = this._toNumber(om[1]);
    const cm = sgdText.match(/Closing Balance\s+([\d,]+\.\d{2})/i);
    if (cm) closingBalance = this._toNumber(cm[1]);

    const drop = [
      /^Account Summary/i, /Opening Balance/i, /Closing Balance/i,
      /Total Debit/i, /Total Credit/i, /of which Interest Earned/i,
      /^Date\s+Description/i, /ANEXT Business Account/i, /^Account No/i,
      /^Period\b/i, /Issue Date/i
    ];
    const lines = sgdText.split('\n').map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; })
      .filter(function (l) {
        for (let k = 0; k < self._NOISE.length; k++) { if (self._NOISE[k].test(l)) return false; }
        for (let k = 0; k < drop.length; k++) { if (drop[k].test(l)) return false; }
        return true;
      });

    const transactions = [];
    const pending = []; // transactions whose amounts appear on a later line

    lines.forEach(function (line) {
      const m = line.match(dateHead);
      if (m) {
        const toks = m[2].trim().split(/\s+/);
        const trailing = [];
        while (toks.length && AMT.test(toks[toks.length - 1])) trailing.unshift(toks.pop());
        const t = {
          date: self._parseAnextDate(m[1]),
          description: toks.join(' ').trim(),
          amounts: (trailing.indexOf('-') !== -1) ? trailing : null,
          payerPayee: ''
        };
        transactions.push(t);
        if (t.amounts === null) pending.push(t); // amounts on a following line
        return;
      }
      const toks = line.split(/\s+/).filter(function (x) { return x.length; });
      const allAmt = toks.length > 0 && toks.every(function (x) { return AMT.test(x); });
      if (allAmt && toks.indexOf('-') !== -1) {
        if (pending.length) pending.shift().amounts = toks; // amount line for next pending txn
      } else if (allAmt) {
        // lone number(s) = daily balance -- ignore
      } else if (transactions.length) {
        transactions[transactions.length - 1].description += ' ' + line; // desc continuation
      }
    });

    const out = transactions.map(function (t) {
      const a = t.amounts || [];
      const debit = a[0], credit = a[1];
      const desc = t.description;
      return {
        date: t.date,
        description: desc,
        outgoing: (debit && debit !== '-') ? self._toNumber(debit) : null,
        incoming: (credit && credit !== '-') ? self._toNumber(credit) : null,
        balance: null,
        payerPayee: self._extractCounterparty(desc)
      };
    });

    // Reconstruct a running balance (for dedup) from the summary opening.
    if (openingBalance !== null) {
      let run = openingBalance;
      out.forEach(function (t) {
        run = Math.round((run + (t.incoming || 0) - (t.outgoing || 0)) * 100) / 100;
        t.balance = run;
      });
    }

    return { openingBalance: openingBalance, closingBalance: closingBalance, transactions: out };
  },

  // -----------------------------------------------------------------------

  _extractAccountNumber: function (text) {
    const m = text.match(/Account\s*(?:No|Number)\.?\s*[:：]?\s*([0-9]{5,})/i);
    return m ? m[1] : null;
  },

  _extractStatementPeriod: function (text) {
    const d = '(\\d{1,2}[\\s-][A-Za-z]{3,9}[\\s-]\\d{4})';
    const m = text.match(new RegExp('(?:Statement\\s+)?Period\\s*[:：]?\\s*' + d + '\\s*to\\s*' + d, 'i'));
    if (!m) return { start: null, end: null };
    return { start: this._parseAnextDate(m[1]), end: this._parseAnextDate(m[2]) };
  },

  _parseAnextDate: function (str) {
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const m = String(str).match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-](\d{4})$/);
    if (!m) return null;
    const month = months[m[2].substring(0, 3).toUpperCase()];
    if (month === undefined) return null;
    return new Date(parseInt(m[3], 10), month, parseInt(m[1], 10));
  },

  /**
   * Returns just the SGD currency section: from the first standalone "SGD"
   * line up to the next currency section (USD/CNH/EUR/...). Only SGD is
   * parsed by _extractTransactions/_extractNewFormat above; if you need
   * another currency, extend the terminator list here.
   */
  _isolateSGD: function (text) {
    const lines = text.split('\n').map(function (l) { return l.trim(); });
    let start = -1, end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (start === -1 && /^SGD$/i.test(lines[i])) { start = i; continue; }
      if (start !== -1 && /^(USD|CNH|EUR|GBP|AUD|JPY|HKD|CNY|RMB)$/i.test(lines[i])) { end = i; break; }
    }
    if (start === -1) return text; // no SGD marker -- fall back to all text
    return lines.slice(start, end).join('\n');
  },

  // Header/footer/page-furniture lines to drop before parsing. These carry
  // no transaction data and would otherwise inject junk into descriptions.
  // Add your own account holder name/address here if OCR repeats it as a
  // running page header in your statements (it's not included by default
  // since it's specific to whoever the statement belongs to, not to the
  // bank's format).
  _NOISE: [
    /^Account Statement/i, /^Account\s*No/i,
    /^(Statement\s+)?Period/i, /Issue Date/i,
    /^SGD$/i, /^USD$/i, /^CNH$/i, /^EUR$/i,
    /ANEXT\.com/i, /ANEXT Bank Pte/i, /^Page\s*\d/i, /^\d+\s*\/\s*\d+$/,
    /subsidiary of Ant Group/i, /Co\.\s*Reg/i, /Incorporated in Singapore/i,
    /^Important Notes/i, /^Please examine/i, /^For more information/i, /^©/, /^Bringing about/i
  ],

  _extractTransactions: function (sgdText) {
    const self = this;

    const lines = sgdText.split('\n').map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; })
      .filter(function (l) {
        for (let k = 0; k < self._NOISE.length; k++) { if (self._NOISE[k].test(l)) return false; }
        return true;
      });

    let s = ' ' + lines.join(' ') + ' ';
    // Transaction-table header -- old ("... Balance") and new ("... Daily Balance").
    s = s.replace(/Date\s+Description\s+Debit\s+Credit\s+(Daily\s+)?Balance/gi, ' ');

    // Opening balance: the NEW layout labels it "Opening Balance"; the older
    // one "Balance Brought Forward". Take the first match of either.
    let openingBalance = null;
    const om = s.match(/Opening Balance\s+([\d,]+\.\d{2})/i) ||
               s.match(/Balance Brought Forward\s+([\d,]+\.\d{2})/i);
    if (om) openingBalance = this._toNumber(om[1]);

    // Strip the NEW "Account Summary" block + all balance markers so their
    // figures (opening / closing / total debit / total credit / interest) can
    // never leak into the transaction amount stream.
    s = s.replace(/Account Summary/gi, ' ');
    s = s.replace(/of which Interest Earned\s+[\d,]+\.\d{2}/gi, ' ');
    s = s.replace(/Opening Balance\s+[\d,]+\.\d{2}/gi, ' ');
    s = s.replace(/Closing Balance\s+[\d,]+\.\d{2}/gi, ' ');
    s = s.replace(/Total Debit\s+[\d,]+\.\d{2}/gi, ' ');
    s = s.replace(/Total Credit\s+[\d,]+\.\d{2}/gi, ' ');
    s = s.replace(new RegExp('(' + this._DATE + '\\s+)?Balance Brought Forward\\s+[\\d,]+\\.\\d{2}', 'gi'), ' ');

    // Strip per-currency "Total" rows (old layout).
    s = s.replace(/Total\s+[\d,]+\.\d{2}/gi, ' ');

    // Ordered descriptions: split on date markers (chunk[i+1] follows date[i]).
    const dates = s.match(new RegExp(this._DATE, 'g')) || [];
    const chunks = s.split(new RegExp(this._DATE));

    // Ordered amount triples [Debit, Credit, Balance].
    const amtTokens = s.split(/\s+/).filter(function (t) { return self._AMOUNT.test(t); });
    const triples = [];
    for (let i = 0; i + 3 <= amtTokens.length; i += 3) {
      triples.push([amtTokens[i], amtTokens[i + 1], amtTokens[i + 2]]);
    }

    const n = Math.min(dates.length, triples.length);
    const transactions = [];
    for (let i = 0; i < n; i++) {
      const date = this._parseAnextDate(dates[i].trim());
      const desc = (chunks[i + 1] || '').split(/\s+/)
        .filter(function (t) { return t.length > 0 && !self._AMOUNT.test(t); })
        .join(' ').trim();
      const debit = triples[i][0], credit = triples[i][1], balance = triples[i][2];

      transactions.push({
        date: date,
        description: desc,
        outgoing: debit === '-' ? null : this._toNumber(debit),
        incoming: credit === '-' ? null : this._toNumber(credit),
        balance: this._toNumber(balance),
        payerPayee: this._extractCounterparty(desc)
      });
    }

    // If the two streams didn't line up 1:1, flag it so balance validation
    // surfaces the file rather than silently dropping rows.
    if (dates.length !== triples.length && transactions.length > 0) {
      transactions[transactions.length - 1].parseWarning =
        'Row/amount mismatch: ' + dates.length + ' dated rows vs ' + triples.length + ' amount triples';
    }

    return { openingBalance: openingBalance, transactions: transactions };
  },

  /**
   * Pulls the real counterparty from "... From/to <name> (Account Ending ####)".
   * Returns '' for interest/fee/loan lines that have no From/to party.
   */
  _extractCounterparty: function (description) {
    const m = String(description || '').match(/\b(?:From|To)\s+(.+?)\s*(?:\(Account Ending|\(A\/C|\(Account No|$)/i);
    if (!m) return '';
    return m[1].replace(/\s+/g, ' ').trim();
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
   * business-specific. Leaves everything else uncategorized ('') since that
   * genuinely depends on what the transaction is for, which only the account
   * holder knows. Feel free to ignore transaction.type entirely and build
   * your own categorization on top of the parsed fields instead.
   */
  guessType: function (transaction) {
    const desc = (transaction.description || '').toUpperCase();
    if (transaction.incoming !== null && desc.indexOf('INTEREST EARNED') !== -1) {
      transaction.payerPayee = this.BANK_NAME;
      return 'BANK INTEREST';
    }
    if (/(MONTHLY ACCOUNT FEE|ACCOUNT FEE|SERVICE CHARGE|SERVICE FEE|FALL BELOW FEE|ADMIN FEE|MONTHLY FEE|BANK CHARGE)/.test(desc)) {
      transaction.payerPayee = this.BANK_NAME;
      return 'BANK CHARGES';
    }
    return '';
  }
};
