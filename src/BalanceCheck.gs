/**
 * BalanceCheck.gs
 * -----------------------------------------------------------------------
 * Pure-arithmetic tally checks shared by every parser. Required (not
 * optional, unlike Extract.gs) -- ParserAnext.gs, ParserDbs.gs, and
 * ParserGeneric.gs all call validateStatementBalance() at the end of
 * parse() and attach the result as statement.balanceCheck.
 *
 * validateStatementBalance() checks the statement's OWN reported numbers
 * add up -- nothing about ledgers, categorization, or any downstream
 * system. It answers exactly one question: "does opening + sum(
 * transactions) equal closing, and does each row's own printed running
 * balance (where the bank prints one) agree with the running total?" A
 * `false` result almost always means a row was mis-parsed or dropped, not
 * that the bank's own statement is wrong.
 *
 * checkStatementContinuity() answers a DIFFERENT question -- one this
 * parser has no way to check on its own, because it only ever sees one
 * statement at a time: "does THIS statement pick up where the LAST one
 * left off?" That requires remembering last month's closing balance
 * somewhere between runs, which is inherently your call (a spreadsheet
 * cell, a database row, Script Properties, a JSON file -- whatever you're
 * already using to persist state), so this function takes that
 * previously-known balance as a plain argument rather than assuming any
 * particular storage. Not called automatically by parse() -- you call it
 * yourself once you've fetched (or don't have) a previous balance.
 * -----------------------------------------------------------------------
 */

/**
 * @param {Object} statement - the object returned by a parser's parse()
 *   (must have openingBalance, closingBalance, transactions).
 * @param {number} [tolerance=0.01]
 * @return {{passed: boolean, reason: string, expectedClosing: ?number,
 *           calculatedClosing: ?number, variance: ?number}}
 */
function validateStatementBalance(statement, tolerance) {
  // Currency values are expected to agree to the cent. A half-cent threshold
  // avoids allowing a full one-cent variance through the control.
  const tol = (tolerance === undefined) ? 0.005 : tolerance;
  const txns = statement.transactions || [];
  if (statement.openingBalance === null || statement.openingBalance === undefined ||
      statement.closingBalance === null || statement.closingBalance === undefined) {
    return {
      passed: false,
      reason: 'Could not determine opening or closing balance from statement text.',
      expectedClosing: statement.closingBalance,
      calculatedClosing: null,
      variance: null
    };
  }

  if (!txns.length) {
    return {
      passed: false,
      reason: 'No transactions were parsed.',
      expectedClosing: statement.closingBalance,
      calculatedClosing: statement.openingBalance,
      variance: null
    };
  }

  let running = statement.openingBalance;
  let breakRow = null;
  let warningRow = null;
  let totalDebit = 0;
  let totalCredit = 0;
  let totalInterest = 0;
  txns.forEach(function (t, i) {
    const incoming = Number(t.incoming || 0);
    const outgoing = Number(t.outgoing || 0);
    totalDebit += outgoing;
    totalCredit += incoming;
    if (/INTEREST\s+EARNED/i.test(String(t.description || ''))) totalInterest += incoming;
    running = Math.round((running + incoming - outgoing) * 100) / 100;
    if (warningRow === null && t.parseWarning) warningRow = i + 1;
    if (t.balance !== null && t.balance !== undefined) {
      if (breakRow === null && Math.abs(t.balance - running) > tol) breakRow = i + 1;
    }
  });

  const calculatedClosing = Math.round(running * 100) / 100;
  const variance = Math.round((calculatedClosing - statement.closingBalance) * 100) / 100;
  const totals = statement.statementTotals;
  let totalsReason = '';
  if (totals) {
    if (totals.debit === null || totals.credit === null || totals.interest === null) {
      totalsReason = 'Could not determine all statement summary totals.';
    } else if (Math.abs(totalDebit - totals.debit) >= tol) {
      totalsReason = 'Parsed debit total does not match statement Total Debit.';
    } else if (Math.abs(totalCredit - totals.credit) >= tol) {
      totalsReason = 'Parsed credit total does not match statement Total Credit.';
    } else if (Math.abs(totalInterest - totals.interest) >= tol) {
      totalsReason = 'Parsed interest total does not match statement Interest Earned.';
    }
  }
  const reason = warningRow !== null ? ('Parse warning at transaction ' + warningRow) :
    (breakRow !== null ? ('Running balance breaks at transaction ' + breakRow) :
    (totalsReason || (Math.abs(variance) >= tol ? 'Calculated closing balance does not match statement closing balance.' : '')));
  const passed = reason === '';

  return {
    passed: passed,
    reason: reason,
    expectedClosing: statement.closingBalance,
    calculatedClosing: calculatedClosing,
    variance: variance,
    parsedTotals: {
      debit: Math.round(totalDebit * 100) / 100,
      credit: Math.round(totalCredit * 100) / 100,
      interest: Math.round(totalInterest * 100) / 100
    }
  };
}

/**
 * Checks that this statement's opening balance matches the closing balance
 * you last recorded (from the previous month's statement) -- catches a
 * missing/skipped month, or the wrong account/period being imported.
 *
 * First-ever statement (no previous balance yet): pass `null` or
 * `undefined` for previousClosingBalance -- this is treated as "nothing to
 * compare against" and always passes. There's no special-casing needed on
 * your end; you don't have to detect "is this the first month" yourself,
 * just pass whatever you have (or don't have) on record.
 *
 * @param {Object} statement - the object returned by a parser's parse().
 * @param {?number} previousClosingBalance - the closing balance you
 *   recorded from the last statement you imported for this account, or
 *   null/undefined if you don't have one yet (first import, or you simply
 *   don't track this).
 * @param {number} [tolerance=0.01]
 * @return {{ok: boolean, reason: string, thisOpening: ?number,
 *           previousClosing: ?number, gap: ?number}}
 */
function checkStatementContinuity(statement, previousClosingBalance, tolerance) {
  const tol = (tolerance === undefined) ? 0.005 : tolerance;
  const thisOpening = statement.openingBalance;

  if (previousClosingBalance === null || previousClosingBalance === undefined) {
    // Nothing on record to compare against -- either this is the very
    // first statement for this account, or the caller isn't tracking
    // continuity. Either way, there's nothing to flag.
    return { ok: true, reason: '', thisOpening: thisOpening, previousClosing: null, gap: null };
  }

  if (thisOpening === null || thisOpening === undefined) {
    return {
      ok: false,
      reason: 'Cannot verify continuity because this statement opening balance is missing.',
      thisOpening: null,
      previousClosing: previousClosingBalance,
      gap: null
    };
  }

  const gap = Math.round((Number(thisOpening) - Number(previousClosingBalance)) * 100) / 100;
  const ok = Math.abs(gap) <= tol;

  return {
    ok: ok,
    reason: ok ? '' : ('This statement opens at ' + Number(thisOpening).toFixed(2) +
      ' but the last recorded closing balance was ' + Number(previousClosingBalance).toFixed(2) +
      ' (gap ' + gap.toFixed(2) + '). A month may be missing between them, or this is the ' +
      'wrong account/period.'),
    thisOpening: thisOpening,
    previousClosing: previousClosingBalance,
    gap: gap
  };
}

/**
 * Fail-closed import gate. Call this immediately before writing rows.
 * @throws {Error} when the statement or month-to-month continuity fails.
 */
function assertStatementReadyForImport(statement, previousClosingBalance, tolerance) {
  const balance = statement.balanceCheck || validateStatementBalance(statement, tolerance);
  if (!balance.passed) throw new Error('Statement validation failed: ' + balance.reason);
  const continuity = checkStatementContinuity(statement, previousClosingBalance, tolerance);
  if (!continuity.ok) throw new Error('Statement continuity failed: ' + continuity.reason);
  return { balanceCheck: balance, continuityCheck: continuity };
}
