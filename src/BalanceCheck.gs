/**
 * BalanceCheck.gs
 * -----------------------------------------------------------------------
 * Pure-arithmetic tally check shared by every parser. Required (not
 * optional, unlike Extract.gs) -- ParserAnext.gs, ParserDbs.gs, and
 * ParserGeneric.gs all call validateStatementBalance() at the end of
 * parse() and attach the result as statement.balanceCheck.
 *
 * This checks the statement's OWN reported numbers add up -- nothing about
 * ledgers, categorization, or any downstream system. It answers exactly one
 * question: "does opening + sum(transactions) equal closing, and does each
 * row's own printed running balance (where the bank prints one) agree with
 * the running total?" A `false` result almost always means a row was
 * mis-parsed or dropped, not that the bank's own statement is wrong.
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
  const tol = (tolerance === undefined) ? 0.01 : tolerance;
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

  let running = statement.openingBalance;
  let breakRow = null;
  txns.forEach(function (t, i) {
    const net = (t.incoming || 0) - (t.outgoing || 0);
    running += net;
    if (t.balance !== null && t.balance !== undefined) {
      if (breakRow === null && Math.abs(t.balance - running) > tol) breakRow = i + 1;
      running = t.balance; // re-anchor to the statement's own running balance
    }
  });

  const calculatedClosing = Math.round(running * 100) / 100;
  const variance = Math.round((calculatedClosing - statement.closingBalance) * 100) / 100;
  const passed = (breakRow === null) && Math.abs(variance) < tol;

  return {
    passed: passed,
    reason: breakRow !== null ? ('Running balance breaks at transaction ' + breakRow) : '',
    expectedClosing: statement.closingBalance,
    calculatedClosing: calculatedClosing,
    variance: variance
  };
}
