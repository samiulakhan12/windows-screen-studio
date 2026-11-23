/**
 * The message keys of auto-blur's UI (docs/design/auto-blur.md §2, §12.1), by the place that shows them.
 * Written by the contracts step with the whole `privacy` catalogue, so every part names its texts
 * from one typed table and no UI text is written outside the catalogues. Keys only: never text.
 */
import type { MessageKey } from '../i18n/keys'
import type { PrivateKind } from '../types'

/** Each kind's checkbox label and its standalone title (a noun phrase for labels and lists, never inside a sentence). */
export const kindLabel = (kind: Exclude<PrivateKind, 'text'>): MessageKey => `privacy.kind.${kind}.label` as MessageKey
export const kindTitle = (kind: PrivateKind): MessageKey => `privacy.kind.${kind}.title` as MessageKey
/** The notifications kind's hint under its checkbox. */
export const NOTICE_HINT: MessageKey = 'privacy.kind.notice.hint'

export const PRIVACY_COPY = {
  section: {
    title: 'privacy.section.title',
    addCover: 'privacy.section.addCover',
    addCoverMenu: 'privacy.section.addCoverMenu',
    find: 'privacy.section.find',
    count: 'privacy.section.count',
    toCheck: 'privacy.section.toCheck',
    review: 'privacy.section.review',
    readerMissing: 'privacy.section.readerMissing',
    showCovers: 'privacy.section.showCovers',
    showCoversHint: 'privacy.section.showCoversHint',
    weak: 'privacy.section.weak',
    weakTurn: 'privacy.section.weakTurn',
    notSee: 'privacy.section.notSee'
  },
  cover: {
    lengthThree: 'privacy.cover.length.three',
    lengthToEnd: 'privacy.cover.length.toEnd',
    lengthWhole: 'privacy.cover.length.whole',
    title: 'privacy.cover.title',
    colour: 'privacy.cover.colour',
    colourRing: 'privacy.cover.colour.ring',
    colourDark: 'privacy.cover.colour.dark',
    colourLight: 'privacy.cover.colour.light',
    colourBlack: 'privacy.cover.colour.black',
    colourWhite: 'privacy.cover.colour.white',
    box: 'privacy.cover.box',
    boxLeft: 'privacy.cover.box.left',
    boxTop: 'privacy.cover.box.top',
    boxWidth: 'privacy.cover.box.width',
    boxHeight: 'privacy.cover.box.height',
    wholePath: 'privacy.cover.wholePath',
    wholePathHint: 'privacy.cover.wholePathHint',
    startHere: 'privacy.cover.startHere',
    endHere: 'privacy.cover.endHere',
    outside: 'privacy.cover.outside',
    follow: 'privacy.cover.follow',
    followHint: 'privacy.cover.followHint',
    following: 'privacy.cover.following',
    followStop: 'privacy.cover.followStop',
    followDone: 'privacy.cover.followDone',
    followNone: 'privacy.cover.followNone',
    everywhere: 'privacy.cover.everywhere',
    whole: 'privacy.cover.whole',
    keep: 'privacy.cover.keep',
    uncover: 'privacy.cover.uncover',
    uncovered: 'privacy.cover.uncovered',
    found: 'privacy.cover.found',
    what: 'privacy.cover.what',
    toCheck: 'privacy.cover.toCheck',
    lost: 'privacy.cover.lost',
    missed: 'privacy.cover.missed',
    thin: 'privacy.cover.thin',
    timeKept: 'privacy.cover.timeKept',
    oneProject: 'privacy.cover.oneProject',
    selected: 'privacy.cover.selected',
    oneForBox: 'privacy.cover.oneForBox',
    oneForFollow: 'privacy.cover.oneForFollow',
    oneForEverywhere: 'privacy.cover.oneForEverywhere'
  },
  shape: {
    cover: 'privacy.shape.cover',
    coverTitle: 'privacy.shape.cover.title'
  },
  weak: {
    turnSelected: 'privacy.weak.turnSelected',
    note: 'privacy.weak.note',
    turn: 'privacy.weak.turn'
  },
  everywhere: {
    title: 'privacy.everywhere.title',
    body: 'privacy.everywhere.body',
    reading: 'privacy.everywhere.reading',
    noText: 'privacy.everywhere.noText',
    needsReader: 'privacy.everywhere.needsReader',
    remember: 'privacy.everywhere.remember',
    rememberNo: 'privacy.everywhere.rememberNo',
    rememberThis: 'privacy.everywhere.rememberThis',
    rememberAll: 'privacy.everywhere.rememberAll',
    start: 'privacy.everywhere.start',
    done: 'privacy.everywhere.done',
    failed: 'privacy.everywhere.failed'
  },
  track: {
    title: 'privacy.track.title',
    item: 'privacy.track.item',
    itemCheck: 'privacy.track.itemCheck',
    itemWaiting: 'privacy.track.itemWaiting',
    itemMine: 'privacy.track.itemMine',
    group: 'privacy.track.group',
    thin: 'privacy.track.thin'
  },
  find: {
    title: 'privacy.find.title',
    intro: 'privacy.find.intro',
    what: 'privacy.find.what',
    regions: 'privacy.find.regions',
    regionsChange: 'privacy.find.regionsChange',
    regionsTitle: 'privacy.find.regionsTitle',
    regionsHint: 'privacy.find.regionsHint',
    names: 'privacy.find.names',
    namesHint: 'privacy.find.namesHint',
    neverHide: 'privacy.find.neverHide',
    neverHideHint: 'privacy.find.neverHideHint',
    everyVideo: 'privacy.find.everyVideo',
    listen: 'privacy.find.listen',
    listenHint: 'privacy.find.listenHint',
    listenNone: 'privacy.find.listenNone',
    readerNone: 'privacy.find.readerNone',
    readerDownload: 'privacy.find.readerDownload',
    readerProgress: 'privacy.find.readerProgress',
    readerFailed: 'privacy.find.readerFailed',
    readerRetry: 'privacy.find.readerRetry',
    estimate: 'privacy.find.estimate',
    again: 'privacy.find.again',
    start: 'privacy.find.start',
    startAgain: 'privacy.find.startAgain',
    cancel: 'privacy.find.cancel'
  },
  run: {
    look: 'privacy.run.look',
    read: 'privacy.run.read',
    follow: 'privacy.run.follow',
    left: 'privacy.run.left',
    stop: 'privacy.run.stop',
    waiting: 'privacy.run.waiting',
    foundNone: 'privacy.run.foundNone',
    notSeeLink: 'privacy.run.notSeeLink',
    found: 'privacy.run.found',
    foundCheck: 'privacy.run.foundCheck',
    said: 'privacy.run.said',
    failedReads: 'privacy.run.failedReads',
    thinned: 'privacy.run.thinned',
    suppressed: 'privacy.run.suppressed',
    saidFull: 'privacy.run.saidFull',
    stopped: 'privacy.run.stopped',
    busy: 'privacy.run.busy',
    tooLarge: 'privacy.run.tooLarge',
    readerDamaged: 'privacy.run.readerDamaged',
    downloadAgain: 'privacy.run.downloadAgain',
    failedHelper: 'privacy.run.failed.helper',
    failedVideo: 'privacy.run.failed.video',
    failedCrashed: 'privacy.run.failed.crashed',
    failedOther: 'privacy.run.failed.other',
    openReview: 'privacy.run.openReview'
  },
  leave: {
    body: 'privacy.leave.body',
    action: 'privacy.leave.action'
  },
  review: {
    title: 'privacy.review.title',
    where: 'privacy.review.where',
    places: 'privacy.review.places',
    area: 'privacy.review.area',
    place: 'privacy.review.place',
    check: 'privacy.review.check',
    said: 'privacy.review.said',
    lost: 'privacy.review.lost',
    missed: 'privacy.review.missed',
    thin: 'privacy.review.thin',
    keep: 'privacy.review.keep',
    uncover: 'privacy.review.uncover',
    keepRow: 'privacy.review.keepRow',
    uncoverRow: 'privacy.review.uncoverRow',
    uncovered: 'privacy.review.uncovered',
    select: 'privacy.review.select',
    peek: 'privacy.review.peek',
    peekRow: 'privacy.review.peekRow',
    peekAll: 'privacy.review.peekAll',
    peekAllHint: 'privacy.review.peekAllHint',
    listen: 'privacy.review.listen',
    listenRow: 'privacy.review.listenRow',
    filter: 'privacy.review.filter',
    filterAll: 'privacy.review.filterAll',
    keepKind: 'privacy.review.keepKind',
    uncoverKind: 'privacy.review.uncoverKind',
    uncoverConfirm: 'privacy.review.uncoverConfirm',
    uncoverConfirmAction: 'privacy.review.uncoverConfirmAction',
    done: 'privacy.review.done',
    doneConfirm: 'privacy.review.doneConfirm',
    doneCheck: 'privacy.review.doneCheck',
    doneKeep: 'privacy.review.doneKeep',
    emptyKind: 'privacy.review.emptyKind',
    findAgain: 'privacy.review.findAgain',
    unfinished: 'privacy.review.unfinished'
  },
  peek: {
    banner: 'privacy.peek.banner',
    stop: 'privacy.peek.stop',
    inset: 'privacy.peek.inset'
  },
  notSee: {
    scripts: 'privacy.notSee.scripts',
    small: 'privacy.notSee.small',
    names: 'privacy.notSee.names',
    brief: 'privacy.notSee.brief',
    unlabelled: 'privacy.notSee.unlabelled',
    pictures: 'privacy.notSee.pictures',
    added: 'privacy.notSee.added',
    off: 'privacy.notSee.off',
    said: 'privacy.notSee.said',
    length: 'privacy.notSee.length',
    folder: 'privacy.notSee.folder',
    check: 'privacy.notSee.check'
  },
  export: {
    hides: 'privacy.export.hides',
    toCheck: 'privacy.export.toCheck',
    review: 'privacy.export.review',
    weak: 'privacy.export.weak',
    weakTurn: 'privacy.export.weakTurn',
    notChecked: 'privacy.export.notChecked',
    find: 'privacy.export.find',
    unfinished: 'privacy.export.unfinished',
    thinned: 'privacy.export.thinned',
    saidRemoved: 'privacy.export.saidRemoved',
    running: 'privacy.export.running',
    wait: 'privacy.export.wait',
    stopAndExport: 'privacy.export.stopAndExport',
    captionsChanged: 'privacy.export.captionsChanged',
    findAgain: 'privacy.export.findAgain',
    fromOriginal: 'privacy.export.fromOriginal',
    bringOver: 'privacy.export.bringOver',
    recordingsOff: 'privacy.export.recordingsOff',
    recordingsSkipped: 'privacy.export.recordingsSkipped'
  },
  copies: {
    offer: 'privacy.copies.offer',
    done: 'privacy.copies.done'
  },
  settings: {
    title: 'privacy.settings.title',
    reader: 'privacy.settings.reader',
    readerAbout: 'privacy.settings.readerAbout',
    readerReady: 'privacy.settings.readerReady',
    readerNone: 'privacy.settings.readerNone',
    readerDamaged: 'privacy.settings.readerDamaged',
    download: 'privacy.settings.download',
    cancel: 'privacy.settings.cancel',
    remove: 'privacy.settings.remove',
    kinds: 'privacy.settings.kinds',
    names: 'privacy.settings.names',
    neverHide: 'privacy.settings.neverHide',
    regions: 'privacy.settings.regions',
    colour: 'privacy.settings.colour',
    withPolish: 'privacy.settings.withPolish',
    unavailableHelper: 'privacy.settings.unavailable.helper',
    unavailableCpu: 'privacy.settings.unavailable.cpu'
  },
  guide: {
    covered: 'privacy.guide.covered',
    notChecked: 'privacy.guide.notChecked',
    unfinished: 'privacy.guide.unfinished'
  },
  translated: {
    masked: 'privacy.translated.masked'
  },
  transcribe: {
    hears: 'privacy.transcribe.hears'
  },
  publish: {
    masked: 'privacy.publish.masked'
  }
} as const satisfies Record<string, Record<string, MessageKey>>

/** Polish's Find private info row and result lines (§2.10), in the review namespace. */
export const POLISH_PRIVACY_COPY = {
  step: 'review.polish.step.privacy',
  hint: 'review.polish.hint.privacy',
  hintChecked: 'review.polish.hint.privacyChecked',
  result: 'review.polish.result.privacy',
  resultCheck: 'review.polish.result.privacyCheck',
  resultListened: 'review.polish.result.privacyListened',
  resultUnfinished: 'review.polish.result.privacyUnfinished',
  skipNoReader: 'review.polish.skip.noReader'
} as const satisfies Record<string, MessageKey>
