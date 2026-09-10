const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const context = { console };
vm.createContext(context);
for (const file of ['BalanceCheck.gs', 'ParserAnext.gs']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
}

const parse = text => vm.runInContext('ParserAnext.parse(__text)', Object.assign(context, { __text: text }));

const valid = `
ANEXT BANK Account Statement
Account No: 123456789
Period: 01 Jul 2026 to 31 Jul 2026
SGD
Account Summary
Opening Balance 100.00
Total Debit 20.00
Total Credit 25.04
of which Interest Earned 0.04
Closing Balance 105.04
Date Description Debit Credit Daily Balance
01 Jul 2026 Incoming PAYNOW From SAMPLE CUSTOMER (Account Ending 1111) - 25.00
01 Jul 2026 Outgoing FAST Transfer to SAMPLE SUPPLIER (Account Ending 2222) 20.00 -
Page 2/2
ANEXT.com.sg
02 Jul 2026 Interest Earned - 0.04
105.04
`;

const ok = parse(valid);
assert.strictEqual(ok.transactions.length, 3, 'first transaction after a page marker must not be dropped');
assert.strictEqual(ok.balanceCheck.passed, true, ok.balanceCheck.reason);
assert.deepStrictEqual(JSON.parse(JSON.stringify(ok.balanceCheck.parsedTotals)), {
  debit: 20,
  credit: 25.04,
  interest: 0.04
});

const droppedPageFirstRow = valid.replace('02 Jul 2026 Interest Earned - 0.04\n', '');
const missing = parse(droppedPageFirstRow);
assert.strictEqual(missing.balanceCheck.passed, false);
assert.match(missing.balanceCheck.reason, /credit total|closing balance/i);

const wrongAmount = valid.replace('- 25.00', '- 24.00');
const amountMismatch = parse(wrongAmount);
assert.strictEqual(amountMismatch.balanceCheck.passed, false);
assert.match(amountMismatch.balanceCheck.reason, /credit total/i);

const continuity = vm.runInContext(
  'checkStatementContinuity({openingBalance: 100}, 99.99)', context
);
assert.strictEqual(continuity.ok, false);

assert.throws(() => vm.runInContext(
  'assertStatementReadyForImport(ParserAnext.parse(__badText), 100)',
  Object.assign(context, { __badText: wrongAmount })
), /validation failed/i);

console.log('ANEXT parser regression tests passed');
