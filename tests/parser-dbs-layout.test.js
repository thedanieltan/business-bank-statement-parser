const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Entirely invented text, names, account numbers, references and amounts.
const context = vm.createContext({});
for (const file of ['BalanceCheck.gs', 'ParserDbs.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), context);
}
const parser = vm.runInContext('ParserDbs', context);
const parse = text => parser.parse(text);
const text = `DBS Bank Account Statement
Account No: 0000000000
01-Jan-2030 to 31-Jan-2030
Currency: SGD
Transaction Date Value Date Transaction Details Withdrawal Deposit Balance
Balance Brought Forward 200.00
03-Jan-30 282.10
03-Jan-30 ADVICE ADV DEMO-REF-01 82.10
000000Ref Fee SAMPLE CUSTOMER PTE LTD
Continue on the next page
DBS Bank Ltd
Account Statement
Page 2 of 2
SAMPLE ACCOUNT HOLDER PTE LTD
123 EXAMPLE STREET
Account No: 0000000000
Currency: SGD
Transaction Date Value Date Transaction Details Withdrawal Deposit Balance
05-Jan-30 235.85
05-Jan-30 CLEARING LOANS DEMO-LOAN-01 46.25
Total 46.25 82.10
Balance Carried Forward 235.85
Messages For You
SAMPLE UNRELATED FOOTER PTE LTD
06-Jan-30 NOT A TRANSACTION 9.99`;

let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }

test('page boundaries discard arbitrary holder/address/footer text, not transaction names', () => {
  const result = parse(text);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.balanceCheck.passed, true, result.balanceCheck.reason);
  assert.match(result.transactions[0].description, /Ref Fee SAMPLE CUSTOMER PTE LTD/);
  assert.doesNotMatch(JSON.stringify(result.transactions), /ACCOUNT HOLDER|EXAMPLE STREET|UNRELATED FOOTER|NOT A TRANSACTION|Account Statement|Page 2/);
  assert.equal(result.transactions[0].incoming, 82.10);
  assert.equal(result.transactions[1].outgoing, 46.25);
  assert.equal(result.closingBalance, 235.85);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result.statementTotals)), { debit: 46.25, credit: 82.10 });
  assert.equal(Object.hasOwn(result.statementTotals, 'interest'), false);
});

test('wrapped descriptions resume after a complete repeated table heading', () => {
  const wrapped = text.replace('05-Jan-30 235.85', 'CONTINUED PAYMENT REFERENCE DEMO-02\n05-Jan-30 235.85');
  assert.match(parse(wrapped).transactions[0].description, /CONTINUED PAYMENT REFERENCE DEMO-02/);
});

test('a genuine counterparty beginning Total is retained', () => {
  const renamed = text.replace('000000Ref Fee SAMPLE CUSTOMER PTE LTD', 'TOTAL SAMPLE CUSTOMER PTE LTD');
  assert.match(parse(renamed).transactions[0].description, /TOTAL SAMPLE CUSTOMER PTE LTD/);
});

test('printed summary independently detects offsetting debit/credit omissions', () => {
  const changed = text.replace('Total 46.25 82.10', 'Total 56.25 92.10');
  const result = parse(changed);
  assert.equal(result.balanceCheck.variance, 0);
  assert.equal(result.balanceCheck.passed, false);
  assert.match(result.balanceCheck.reason, /debit total/i);
});

test('printed credit mismatch, malformed summary and duplicate summary fail closed', () => {
  for (const replacement of ['Total 46.25 82.11', 'Total 46.25 unreadable', 'Total 46.25 82.10\nTotal 46.25 82.10']) {
    const result = parse(text.replace('Total 46.25 82.10', replacement));
    assert.equal(result.balanceCheck.passed, false);
    assert.match(result.balanceCheck.reason, /credit total|summary totals/i);
  }
});

test('comma-grouped summary amounts are parsed independently', () => {
  const totals = parser._extractStatementTotals('Withdrawal Deposit Balance\nTotal 1,234.56 2,345.67');
  assert.equal(totals.debit, 1234.56);
  assert.equal(totals.credit, 2345.67);
});

test('the common column heading may precede the currency marker', () => {
  const heading = 'Transaction Date Value Date Transaction Details Withdrawal Deposit Balance';
  const moved = text.replace(new RegExp(heading + '\\n', 'g'), '').replace('Currency: SGD', heading + '\nCurrency: SGD');
  const result = parse(moved);
  assert.equal(result.statementTotals.debit, 46.25);
  assert.equal(result.statementTotals.credit, 82.10);
  assert.equal(result.balanceCheck.passed, true, result.balanceCheck.reason);
});

test('legacy extracts without printed summary or proven column order retain their shape', () => {
  for (const legacy of [text.replace('Total 46.25 82.10\n', ''), text.replace(/Transaction Date Value Date Transaction Details Withdrawal Deposit Balance\n/g, '')]) {
    const result = parse(legacy);
    assert.equal(result.balanceCheck.passed, true, result.balanceCheck.reason);
    assert.equal(Object.hasOwn(result, 'statementTotals'), false);
  }
});

test('split and combined dated rows retain cent-precision cash amounts', () => {
  const combined = text.replace('03-Jan-30 282.10\n03-Jan-30 ADVICE ADV DEMO-REF-01 82.10', '03-Jan-30 03-Jan-30 ADVICE ADV DEMO-REF-01 82.10 282.10')
    .replace('05-Jan-30 235.85\n05-Jan-30 CLEARING LOANS DEMO-LOAN-01 46.25', '05-Jan-30 05-Jan-30 CLEARING LOANS DEMO-LOAN-01 46.25 235.85');
  const result = parse(combined);
  assert.equal(result.balanceCheck.passed, true, result.balanceCheck.reason);
  assert.equal(result.transactions[0].incoming, 82.10);
  assert.equal(result.transactions[1].outgoing, 46.25);
});

test('amounts in another currency do not participate in the SGD summary', () => {
  const other = text.replace('Messages For You', 'Currency: USD\nWithdrawal Deposit Balance\nTotal 900.00 800.00\nMessages For You');
  assert.equal(parse(other).balanceCheck.passed, true);
  assert.equal(parse(other).transactions.length, 2);
});

test('parse does not assign categories; optional hints leave business purpose to callers', () => {
  for (const description of ['ADVICE 000000Ref Fee SAMPLE CUSTOMER PTE LTD', 'CLEARING LOANS DEMO-LOAN-01', 'FAST PAYMENT SAMPLE CUSTOMER PTE LTD', 'CARD PAYMENT SAMPLE SOFTWARE', 'ADVICE DEMO-03']) {
    const transaction = { incoming: 15, outgoing: null, description, payerPayee: 'SAMPLE CUSTOMER PTE LTD' };
    assert.equal(parser.guessType(transaction), '');
    assert.equal(transaction.payerPayee, 'SAMPLE CUSTOMER PTE LTD');
  }
  assert.equal(parse(text).transactions.some(t => Object.hasOwn(t, 'type')), false);
  assert.equal(parser.guessType({ incoming: null, outgoing: 5, description: 'MONTHLY ACCOUNT FEE' }), 'BANK CHARGES');
  assert.equal(parser.guessType({ incoming: 0.01, outgoing: null, description: 'INTEREST EARNED' }), 'BANK INTEREST');
});

console.log(checks + ' DBS layout and caller-categorization checks passed');
