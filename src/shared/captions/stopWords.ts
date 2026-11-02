/**
 * Stop words for auto emphasis (docs/design/captions-studio.md §11.1): short function-word lists
 * per language (en, bn, hi, es, fr, de, pt): articles, pronouns, prepositions, conjunctions,
 * auxiliaries and fillers. Written for Flown, CC0-1.0. The Bangla and Hindi lists need a native
 * speaker's check before release. Negations, "only", "every" and superlatives are never in them
 * (they are signals, §11.1), and neither are verbs a tutorial asks for ("open", "click").
 */

const list = (words: string): ReadonlySet<string> => new Set(words.trim().split(/\s+/))

export const STOP_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  en: list(`
    a an the this that these those there here it its it's itself i me my mine myself we us our ours ourselves you your yours yourself
    yourselves he him his himself she her hers herself they them their theirs themselves what which who whom whose
    am is are was were be been being have has had having do does did doing will would shall should can could may might must
    i'm you're we're they're i've you've we've they've i'll you'll we'll they'll i'd you'd we'd they'd he's she's that's there's
    what's let's
    and or but if then because as until while of at by for with about against between into through during before after above
    below to from up down in out on off over under again further once also just so than too very really quite
    how when where why all any both each few more most other some such own same
    um uh oh okay ok yeah yes well like basically actually right gonna wanna kind sort
    get got go goes going gone make made thing things way stuff lot lots bit one ones something anything
  `),
  bn: list(`
    আমি আমরা আমার আমাদের আমাকে তুমি তোমরা তোমার তোমাদের আপনি আপনারা আপনার আপনাদের আপনাকে সে তারা তার তাদের তাকে
    এ এই ওই ও সেই এটা এটি ওটা ওটি সেটা সেটি এগুলো ওগুলো সেগুলো যা যে যিনি যারা যাকে কী কি কে কেন কোন কোথায় কখন কীভাবে
    এবং আর কিন্তু অথবা বা যদি তবে তাহলে তবু কারণ যেহেতু তাই সুতরাং যখন তখন যেমন তেমন মতো মত
    থেকে হতে দিয়ে দ্বারা জন্য সাথে সঙ্গে কাছে মধ্যে ভিতরে বাইরে উপরে নিচে পরে আগে পর্যন্ত প্রতি নিয়ে বিষয়ে
    হয় হয়ে হলো হল হয়েছে হবে ছিল ছিলেন আছে আছেন আছি থাকে থাকবে করা করে করেন করি করছি করছে করবে করেছে
    একটা একটি কিছু অনেক খুব বেশ আরও এখন এখানে ওখানে সেখানে তো ই ও হ্যাঁ আচ্ছা ঠিক আসলে মানে
  `),
  hi: list(`
    मैं हम मेरा मेरी मेरे हमारा हमारी हमारे मुझे हमें तुम तुम्हारा तुम्हारी आप आपका आपकी आपके आपको वह वे उसका उसकी उसके उनका उनकी उनके उसे उन्हें
    यह ये वो इस उस इन उन जो जिस जिन कौन क्या क्यों कहाँ कब कैसे कोई कुछ
    और या लेकिन पर परंतु किंतु अगर यदि तो क्योंकि इसलिए जब तब जैसे वैसे
    का की के को से में पर तक लिए साथ बाद पहले ऊपर नीचे अंदर बाहर द्वारा बारे
    है हैं था थी थे हो होता होती होते होगा होगी होंगे रहा रही रहे गया गई गए कर करना करते करती करता किया
    एक बहुत काफी अब यहाँ वहाँ भी ही तो हाँ अच्छा ठीक मतलब वाला वाली वाले
  `),
  es: list(`
    el la los las un una unos unas lo al del de en a con por para sin sobre entre hasta desde hacia según tras
    y e o u pero si porque como cuando donde que quien cual cuyo mientras pues
    yo tú usted él ella nosotros nosotras vosotros ellos ellas ustedes me te se nos os le les mi mis tu tus su sus nuestro nuestra
    este esta estos estas ese esa esos esas aquel aquella esto eso aquello aquí ahí allí
    es son era eran fue fueron ser estar está están estaba he ha han había hay haber hace hacer tiene tienen tener va vamos
    muy más menos también ya bueno pues entonces bien algo
  `),
  fr: list(`
    le la les l un une des du de d au aux à en dans par pour sur sous avec sans entre vers chez
    et ou mais donc or ni car si que qu qui quoi dont où comme quand lorsque puis
    je j tu il elle on nous vous ils elles me m te t se s lui leur leurs mon ma mes ton ta tes son sa ses notre nos votre vos
    ce c cet cette ces ça cela ceci ici là voici voilà
    est sont était étaient être été ai as a avons avez ont avait avoir fait faire va allons
    très plus moins aussi alors bien bon donc enfin voilà quelque
  `),
  de: list(`
    der die das den dem des ein eine einen einem einer eines
    und oder aber denn sondern wenn ob dass weil als wie wo wann damit doch
    ich du er sie es wir ihr mich dich sich uns euch mir dir ihm ihnen mein meine dein deine sein seine unser unsere euer ihre
    dies diese dieser dieses jener hier da dort
    in im an am auf aus bei mit nach von vom zu zum zur über unter vor hinter neben zwischen durch für gegen ohne um bis
    ist sind war waren sein bin bist habe hast hat haben hatte werden wird wurde kann können muss soll will
    sehr mehr weniger auch schon noch dann also so ja na gut mal halt eben
  `),
  pt: list(`
    o a os as um uma uns umas do da dos das de em no na nos nas ao aos à às com por pelo pela para sem sobre entre até desde
    e ou mas se porque como quando onde que quem qual cujo enquanto pois então
    eu tu você ele ela nós vós eles elas vocês me te se nos lhe lhes meu minha meus minhas teu tua seu sua seus suas nosso nossa
    este esta estes estas esse essa esses essas aquele aquela isto isso aquilo aqui aí ali lá
    é são era eram foi foram ser estar está estão estava tem têm ter há haver faz fazer vai vamos
    muito mais menos também já bem bom algo tipo
  `)
}
