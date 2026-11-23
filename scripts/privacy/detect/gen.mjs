import { luhn, mod97 } from './rules.mjs'
const luhnComplete = (p) => { for (let c = 0; c < 10; c++) if (luhn(p + c)) return p + c }
for (const p of ['453914880343646', '222300480912374', '37144963539843', '601100099013942', '353011133330000', '620000123456789', '220212345678901', '512345678901234', '430012345678901']) console.log('card', luhnComplete(p))
const iban = (cc, bban) => { const chk = 98 - mod97(cc + '00' + bban); return cc + String(chk).padStart(2, '0') + bban }
for (const [cc, b] of [['DE', '500105175407324931'], ['GB', 'NWBK60161331926819'], ['NL', 'ABNA0417164300'], ['FR', '20041010050500013M02606'], ['ES', '21000418450200051332'], ['PK', 'SCBL0000001123456702'], ['AE', '0331234567890123456']]) { const v = iban(cc, b); console.log('iban', v, mod97(v)) }
