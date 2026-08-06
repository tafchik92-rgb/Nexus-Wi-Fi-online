// Seeds a shop with enough real content that tables, tiles and charts are full.
const PROJECT = 'nexus-pos-fn-test';
const REST = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const S = (v) => ({ stringValue: String(v) });
const N = (v) => ({ integerValue: String(v) });
const A = (arr) => ({ arrayValue: { values: arr } });
const M = (o) => ({ mapValue: { fields: o } });

export async function wipe() {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

const put = (coll, id, fields) =>
  fetch(`${REST}/${coll}?documentId=${id}`, { method: 'POST', headers: OWNER, body: JSON.stringify({ fields }) });

export async function seedBulk(siteIds, agentId, agentName, adminId) {
  const iso = (d) => new Date(d).toISOString();
  const names = ['Amina Diallo','Joel Okafor','Rita Mensah','Kwame Boateng','Lena Fischer',
                 'Samuel Ade','Nadia Toure','Ibrahim Kane','Grace Owusu','Tunde Bello'];
  const jobs = [];
  let n = 0;

  for (const [si, siteId] of siteIds.entries()) {
    for (const [type, count] of [['V5', 40], ['V10', 25], ['REC', 8]]) {
      for (let i = 0; i < count; i++) {
        const sold = i < Math.floor(count / 3);
        jobs.push(put('vouchers', `v${si}-${type}-${i}`, {
          code: S(`${type}-S${si}-${String(i).padStart(4, '0')}-XYZW`), type: S(type),
          siteId: S(siteId), status: S(sold ? 'sold' : 'available'),
          batch: S(`B-${si}${type}`), uploadedAt: S(iso(Date.now() - 20 * 864e5)),
        }));
      }
    }
    // credit accounts with long names and numbers, plus their sales
    for (let i = 0; i < 6; i++) {
      const acc = `acc${si}-${i}`;
      const name = names[(si * 6 + i) % names.length] + (i % 2 ? ' Oyelaran-Fitzgerald' : '');
      jobs.push(put('accounts', acc, {
        name: S(name), phone: S(`+233 ${20 + i} ${100 + i} ${8000 + i}`),
        siteId: S(siteId), createdAt: S(iso(Date.now() - 15 * 864e5)),
      }));
      for (let k = 0; k < 3; k++) {
        const price = k % 2 ? 10 : 5;
        jobs.push(put('sales', `s${si}-${i}-${k}`, {
          customer: S(name), phone: S(`+233 ${20 + i} ${100 + i} ${8000 + i}`),
          accountId: S(acc), voucherId: S(`v${si}-V5-${k}`), voucherCode: S(`V5-S${si}-000${k}-XYZW`),
          type: S(price === 10 ? 'V10' : 'V5'), price: N(price), pay: S('credit'),
          agentId: S(k % 2 ? agentId : adminId), agentName: S(k % 2 ? agentName : 'Ada Mensah'),
          siteId: S(siteId), soldAt: S(iso(Date.now() - (k + i) * 864e5)),
        }));
        n++;
      }
      // a part payment so balances are non-trivial
      jobs.push(put('payments', `p${si}-${i}`, {
        accountId: S(acc), siteId: S(siteId), amount: N(5), method: S(['cash','mobile','bank'][i % 3]),
        note: S('part settlement'), receivedBy: S(i % 2 ? agentId : adminId),
        receivedByName: S(i % 2 ? agentName : 'Ada Mensah'),
        receivedAt: S(iso(Date.now() - i * 864e5)),
        allocations: A([M({ saleId: S(`s${si}-${i}-0`), amount: N(5) })]),
      }));
    }
    // plain cash sales for the chart
    for (let d = 0; d < 7; d++) {
      for (let k = 0; k < 3; k++) {
        jobs.push(put('sales', `c${si}-${d}-${k}`, {
          customer: S(names[(d + k) % names.length]), phone: S(''),
          voucherId: S(`v${si}-V5-${d}`), voucherCode: S(`V5-S${si}-00${d}${k}-XYZW`),
          type: S('V5'), price: N(5), pay: S('cash'),
          agentId: S(k % 2 ? agentId : adminId), agentName: S(k % 2 ? agentName : 'Ada Mensah'),
          siteId: S(siteId), soldAt: S(iso(Date.now() - d * 864e5)),
        }));
      }
    }
  }
  await Promise.all(jobs);
  return n;
}
