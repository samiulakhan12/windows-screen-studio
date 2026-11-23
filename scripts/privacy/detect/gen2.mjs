import { luhn, mod97, cardNetwork } from './rules.mjs'
const luhnComplete = (p) => { for (let c = 0; c < 10; c++) if (luhn(p + c)) return p + c }
for (const p of ['34567890123456', '601198765432101', '358912345678901', '622848123456789', '511122223333444', '491761234567890', '220012345678901', '650031234567890']) { const v = luhnComplete(p); console.log('card', v, cardNetwork(v)) }
const iban = (cc, bban) => { const chk = 98 - mod97(cc + '00' + bban); return cc + String(chk).padStart(2, '0') + bban }
for (const [cc, b] of [['DE', '370502991234567890'], ['GB', 'BARC20005512345678'], ['NL', 'RABO0312345678'], ['FR', '30006000011234567890189'], ['ES', '01821234561234567890'], ['PK', 'HABB0000123456789012'], ['AE', '0260001234567890123']]) { const v = iban(cc, b); console.log('iban', v, mod97(v), v.length) }
// one-digit misread of a valid card
const v = luhnComplete('491761234567890'); const bad = v.slice(0, 7) + ((+v[7] + 3) % 10) + v.slice(8); console.log('misread', bad, luhn(bad))
