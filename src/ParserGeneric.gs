/**
 * ParserGeneric.gs
 * -----------------------------------------------------------------------
 * Fallback parser used when a statement doesn't match ANEXT or DBS
 * detection. This is intentionally conservative: it looks for the most
 * common statement shape (date, description, one or two amount columns,
 * running balance) and flags EVERY row for manual review rather than
 * attempting bank-specific column disambiguation it has no basis for.
 *
 * This parser will not correctly split Withdrawal vs Deposit in most
 * cases -- that logic is genuinely bank-specific (column order, sign
 * conventions, and date formats vary). Its job is to get the raw
 * transaction lines and dates in front of you so you can add a proper
 * parser for that bank, not to silently guess at amounts.
 * -----------------------------------------------------------------------
 */

const ParserGeneric = {

  BANK_NAME: 'UNKNOWN',

  // Generic parser is the fallback of last resort -- it never "detects"
  // itself; pickParser() (see Extract.gs) routes to this parser only when
  // no other detect() returns true.
  detect: function (text) {
    return false;
  },

  parse: function (text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Try a handful of common date formats. First matching format wins;
    // we don't mix formats within one statement.
    const dateFormats = [
      { re: /^(\d{2}-[A-Za-z]{3}-\d{2,4})/, parse: this._parseFlexibleDate },
      { re: /^(\d{2}\/\d{2}\/\d{2,4})/, parse: this._parseSlashDate },
      { re: /^(\d{4}-\d{2}-\d{2})/, parse: this._parseIsoDate }
    ];

    let activeFormat = null;
    for (const fmt of dateFormats) {
      if (lines.some(l => fmt.re.test(l))) {
        activeFormat = fmt;
        break;
      }
    }

    const transactions = [];
    if (!activeFormat) {
      // Could not even find a recognizable date pattern. Return an empty
      // transaction list with a top-level warning rather than fabricate
      // structure that isn't there.
      const empty = {
        bank: this.BANK_NAME,
        accountNumber: null,
        statementPeriod: { start: null, end: null },
        openingBalance: null,
        closingBalance: null,
        transactions: [],
        parseWarning: 'Generic parser could not identify a date column format in this statement. Manual entry required.'
      };
      empty.balanceCheck = validateStatementBalance(empty);
      return empty;
    }

    for (const line of lines) {
      const m = line.match(activeFormat.re);
      if (!m) continue;

      const date = activeFormat.parse(m[1]);
      const rest = line.slice(m[0].length).trim();

      // Pull the last numeric token as a best-guess balance; everything
      // else is left in the description. We deliberately do NOT attempt
      // to split outgoing/incoming here -- every row from this parser
      // is flagged for manual categorization regardless.
      const numRe = /([\d,]+\.\d{2})\s*$/;
      const numMatch = rest.match(numRe);

      transactions.push({
        date: date,
        description: numMatch ? rest.slice(0, numMatch.index).trim() : rest,
        outgoing: null,
        incoming: null,
        balance: numMatch ? this._toNumber(numMatch[1]) : null,
        // Left blank rather than defaulting to a bank name (unlike the
        // ANEXT/DBS parsers) -- this parser doesn't know what bank it's
        // looking at, so writing "UNKNOWN" into PAYER/PAYEE would look
        // like a confident value when it isn't one.
        payerPayee: '',
        parseWarning: 'Parsed by generic fallback parser -- amounts not split into Outgoing/Incoming. Needs manual review.'
      });
    }

    const statement = {
      bank: this.BANK_NAME,
      accountNumber: null,
      statementPeriod: { start: null, end: null },
      openingBalance: null,
      closingBalance: null,
      transactions: transactions,
      parseWarning: 'Statement bank format not recognized (not ANEXT or DBS). All rows require manual review of Outgoing/Incoming amounts.'
    };
    // Opening/closing are never known here, so this will always come back
    // failed -- that's expected and consistent with the parseWarning above,
    // not a bug. Attached anyway so statement.balanceCheck is always present
    // regardless of which parser handled the file.
    statement.balanceCheck = validateStatementBalance(statement);
    return statement;
  },

  guessType: function (transaction) {
    // Unrecognized statement format -- never guess a category. Leave TYPE
    // blank for manual categorization.
    return '';
  },

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  _parseFlexibleDate: function (str) {
    const months = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
    };
    const m = str.match(/^(\d{2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const month = months[m[2].toUpperCase()];
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    if (month === undefined) return null;
    return new Date(year, month, day);
  },

  _parseSlashDate: function (str) {
    const parts = str.split('/');
    if (parts.length !== 3) return null;
    let [d, mo, y] = parts.map(p => parseInt(p, 10));
    if (y < 100) y += 2000;
    return new Date(y, mo - 1, d);
  },

  _parseIsoDate: function (str) {
    const parts = str.split('-');
    if (parts.length !== 3) return null;
    const [y, mo, d] = parts.map(p => parseInt(p, 10));
    return new Date(y, mo - 1, d);
  },

  _toNumber: function (str) {
    if (!str) return null;
    const cleaned = String(str).replace(/,/g, '').trim();
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
};
