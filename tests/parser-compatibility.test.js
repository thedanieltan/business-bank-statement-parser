const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Handwritten synthetic golden cases; no private files or services required.
const context = vm.createContext({});
for (const file of ['BalanceCheck.gs', 'ParserAnext.gs', 'ParserDbs.gs', 'ParserGeneric.gs', 'Extract.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), context);
}
const anext = vm.runInContext('ParserAnext', context);
const dbs = vm.runInContext('ParserDbs', context);
const plain = value => JSON.parse(JSON.stringify(value));
const date = day => new Date(2030, 0, day).toISOString();
const bankCheck = { passed: true, reason: '', expectedClosing: 105.04, calculatedClosing: 105.04, variance: 0,
  parsedTotals: { debit: 20, credit: 25.04, interest: 0.04 } };
const legacy = `ANEXT BANK Account Statement
Account No: 000000000
Period: 01 Jan 2030 to 31 Jan 2030
SGD
Date Description Debit Credit Balance
01 Jan 2030 Balance Brought Forward 100.00
02 Jan 2030 Incoming FAST Transfer From SAMPLE PAYER (Account Ending 0000) - 25.00 125.00
03 Jan 2030 Outgoing FAST Transfer to SAMPLE PAYEE (Account Ending 0000) 20.00 - 105.00
04 Jan 2030 Interest Earned - 0.04 105.04`;
const modern = `ANEXT BANK Account Statement
Account No: 000000000
Period: 01 Jan 2030 to 31 Jan 2030
SGD
Account Summary
Opening Balance 100.00
Total Debit 20.00
Total Credit 25.04
of which Interest Earned 0.04
Closing Balance 105.04
Date Description Debit Credit Daily Balance
02 Jan 2030 Incoming FAST Transfer From SAMPLE PAYER (Account Ending 0000) - 25.00
03 Jan 2030 Outgoing FAST Transfer to SAMPLE PAYEE (Account Ending 0000) 20.00 -
Page 2/2
ANEXT.com.sg
04 Jan 2030 Interest Earned - 0.04
105.04`;
const transactions = [
  { date: date(2), description: 'Incoming FAST Transfer From SAMPLE PAYER (Account Ending 0000)', outgoing: null, incoming: 25, balance: 125, payerPayee: 'SAMPLE PAYER' },
  { date: date(3), description: 'Outgoing FAST Transfer to SAMPLE PAYEE (Account Ending 0000)', outgoing: 20, incoming: null, balance: 105, payerPayee: 'SAMPLE PAYEE' },
  { date: date(4), description: 'Interest Earned', outgoing: null, incoming: 0.04, balance: 105.04, payerPayee: '' }
];
const base = { bank: 'ANEXT', accountNumber: '000000000', statementPeriod: { start: date(1), end: date(31) },
  openingBalance: 100, closingBalance: 105.04, transactions, statementTotals: null, balanceCheck: bankCheck };
assert.deepStrictEqual(plain(anext.parse(legacy)), base, 'legacy ANEXT full output contract changed');
assert.deepStrictEqual(plain(anext.parse(modern)), {
  ...base,
  transactions: transactions.map(t => ({ ...t, balance: null })),
  statementTotals: { debit: 20, credit: 25.04, interest: 0.04 }
}, 'current ANEXT full output contract changed');

const oldDbs = `DBS Bank Account Statement
Account No: 0000000000
01-Jan-2030 to 31-Jan-2030
Currency: SGD
Balance Brought Forward 200.00
02-Jan-30 250.00
02-Jan-30 FAST PAYMENT 50.00
SAMPLE PAYER PTE LTD
03-Jan-30 03-Jan-30 CARD PAYMENT 20.00 230.00
Balance Carried Forward`;
assert.deepStrictEqual(plain(dbs.parse(oldDbs)), {
  bank: 'DBS', accountNumber: '0000000000', statementPeriod: { start: date(1), end: date(31) }, openingBalance: 200, closingBalance: 230,
  transactions: [
    { date: date(2), description: 'FAST PAYMENT SAMPLE PAYER PTE LTD', outgoing: null, incoming: 50, balance: 250, payerPayee: 'FAST PAYMENT SAMPLE PAYER PTE LTD', printedAmount: 50 },
    { date: date(3), description: 'CARD PAYMENT', outgoing: 20, incoming: null, balance: 230, payerPayee: '', printedAmount: 20 }
  ],
  balanceCheck: { passed: true, reason: '', expectedClosing: 230, calculatedClosing: 230, variance: 0, parsedTotals: { debit: 20, credit: 50, interest: 0 } }
}, 'legacy DBS full output contract changed');

for (const text of [legacy, modern]) {
  assert.equal(anext.detect(text), true);
  assert.equal(dbs.detect(text), false);
  assert.equal(context.pickParser(text), anext);
  assert.equal(context.assertStatementReadyForImport(anext.parse(text), 100).balanceCheck.passed, true);
  assert.throws(() => context.assertStatementReadyForImport(anext.parse(text), 99), /continuity failed/);
}
assert.equal(context.pickParser(oldDbs), dbs);
assert.equal(context.pickParser('Unknown statement'), vm.runInContext('ParserGeneric', context));
assert.equal(anext.parse(modern.replace('of which Interest Earned 0.04', '')).balanceCheck.passed, false);
const badInterest = anext.parse(modern.replace('of which Interest Earned 0.04', 'of which Interest Earned 0.05'));
assert.equal(badInterest.balanceCheck.passed, false);
assert.match(badInterest.balanceCheck.reason, /Interest Earned/);
for (const description of ['ADVICE REF FEE', 'CLEARING LOANS', 'Incoming FAST Transfer From SAMPLE PAYER']) {
  assert.equal(anext.guessType({ incoming: 10, outgoing: null, description }), '');
}
assert.equal(anext.guessType({ incoming: 0.04, outgoing: null, description: 'Interest Earned' }), 'BANK INTEREST');
assert.equal(anext.guessType({ incoming: null, outgoing: 10, description: 'Monthly Account Fee' }), 'BANK CHARGES');
console.log('PASS full legacy DBS, legacy/current ANEXT output, routing, continuity and optional-hint compatibility');
