// Fixed UI text for the operator app, in the three languages used on the
// floor. Anything a supervisor TYPES in the admin panel — machine names,
// field labels, work order details, reason labels — is deliberately left
// alone and shown exactly as entered, in whatever language it was written.
// Translating those would mean guessing at a factory's own terminology.
//
// Keys are grouped roughly by screen to make it obvious what a change
// affects. Missing keys fall back to English rather than showing a raw
// key, so a half-finished translation degrades readably.

const STRINGS = {
  en: {
    _name: "English",
    _dir: "ltr",

    // Top bar / sync
    synced: "Synced",
    syncing: "Syncing {n}…",
    offline: "Offline",
    offlineSaved: "Offline — {n} saved locally",

    // Login
    enterId: "Enter your ID number",
    continue: "Continue",
    switchOperator: "Switch operator",
    operatorLabel: "Operator",

    // Queue
    queue: "Queue",
    finished: "Finished",
    refresh: "Refresh",
    noWorkOrders: "No work orders planned for this machine yet.",
    askSupervisor: "Ask your supervisor to add one.",
    nothingFinished: "Nothing finished yet.",
    alreadyInProgress: "Already in progress",
    notYetTopOnly: "Not yet — top {n} only",
    runningNow: "RUNNING NOW",
    workOrderList: "Work order list",
    back: "Back",

    // Plan change
    planChangeTitle: "Please Check – Plan Change",
    planChangeBody: "Your supervisor changed the job plan. Refresh the list before starting anything.",
    refreshNow: "Refresh now",
    dismiss: "Dismiss",
    planChangedBlocked: "The plan changed — go back and refresh the list before starting.",

    // Start / setup
    confirmStart: "Are you sure you want to start this work order?",
    startWork: "Start work",
    startSetup: "Start setup",
    startHint: "Choose Start setup if you need to set the machine up first — that time is recorded separately, and you press Start work when production actually begins.",
    cancel: "Cancel",
    noWorkOrderSelected: "No work order selected — go back and pick one from the queue.",

    // Running
    running: "RUNNING",
    paused: "PAUSED",
    underSetup: "UNDER SETUP",
    pause: "Pause",
    resume: "Resume",
    stop: "Stop",
    startedAt: "Started at {time}",
    setupStartedAt: "Setup started at {time}",
    setupThenWorking: "Setup {duration} · Working since {time}",
    setupInProgress: "Setup in progress — the data tables appear once you press Start work.",
    addRow: "+ Add row",
    noColumns: "No columns configured here yet — ask your supervisor to add some in the admin panel.",
    removeRow: "Remove row",

    // Pause
    whyPausing: "Why are you pausing?",
    searchReason: "Search code or reason…",
    reason: "Reason",
    noReasons: "No reasons are set up for this machine yet — ask your supervisor.",
    nothingMatches: 'Nothing matches "{q}".',

    // Stop
    jobFinished: "Job finished?",
    finishedBtn: "Finished",
    incomplete: "Incomplete / Cancelled",
    whatHappened: "What happened?",
    addRowsBefore: "Add at least one row to {names} before finishing.",
    stillInSetup: "This job is still in setup — press Start work first, or stop it as Incomplete / Cancelled.",

    // Shift
    fieldProcess: "Process",
    fieldQty: "Qty",
    fieldDia: "Dia",
    fieldTol: "Tol",
    fieldDue: "Due",
    priorityNormal: "normal",
    priorityHigh: "high",
    priorityUrgent: "urgent",
    fillRequiredCells: "{screen} row {row}: fill in {fields} before finishing.",
    updateReady: "Update ready — installs when this app is next closed",
    updateDownloading: "Downloading update…",
    scrapCode: "Code",
    scrapDescription: "Description",
    searchFinished: "Search finished jobs…",
    scrapNeedsCode: "Pick a code and enter a weight for every row, or remove the empty rows.",
    shiftFinish: "Shift finish",
    shiftFinishTitle: "Finish shift",
    scrapHint: "Record any scrap from your shift before signing out.",
    scrap: "Scrap",
    scrapMaterial: "Material",
    scrapKg: "Weight (kg)",
    signOut: "Sign out",
    noScrapYet: "No scrap recorded. Add a row, or sign out with none.",
    stopJobFirst: "Stop the job that's still running before finishing your shift.",
    scrapNeedsMaterial: "Pick a material and enter a weight for every row, or remove the empty rows.",
    dayShift: "Day shift",
    nightShift: "Night shift",

    // Errors
    setupNeeded: "Setup needed",
    starting: "Starting…",
  },

  ar: {
    _name: "العربية",
    _dir: "rtl",

    synced: "تمت المزامنة",
    syncing: "جارٍ المزامنة {n}…",
    offline: "غير متصل",
    offlineSaved: "غير متصل — تم حفظ {n} محليًا",

    enterId: "أدخل رقم الهوية الخاص بك",
    continue: "متابعة",
    switchOperator: "تغيير المشغّل",
    operatorLabel: "المشغّل",

    queue: "قائمة الأعمال",
    finished: "مكتملة",
    refresh: "تحديث",
    noWorkOrders: "لا توجد أوامر عمل مخططة لهذه الماكينة بعد.",
    askSupervisor: "اطلب من المشرف إضافة أمر عمل.",
    nothingFinished: "لا يوجد شيء مكتمل بعد.",
    alreadyInProgress: "قيد التنفيذ بالفعل",
    notYetTopOnly: "ليس بعد — أول {n} فقط",
    runningNow: "قيد التشغيل الآن",
    workOrderList: "قائمة أوامر العمل",
    back: "رجوع",

    planChangeTitle: "يرجى التحقق – تغيير في الخطة",
    planChangeBody: "قام المشرف بتغيير خطة العمل. حدّث القائمة قبل بدء أي عمل.",
    refreshNow: "تحديث الآن",
    dismiss: "إغلاق",
    planChangedBlocked: "تغيّرت الخطة — ارجع وحدّث القائمة قبل البدء.",

    confirmStart: "هل أنت متأكد أنك تريد بدء أمر العمل هذا؟",
    startWork: "بدء العمل",
    startSetup: "بدء التجهيز",
    startHint: "اختر «بدء التجهيز» إذا كنت بحاجة إلى تجهيز الماكينة أولًا — يُسجَّل هذا الوقت بشكل منفصل، وتضغط «بدء العمل» عند بدء الإنتاج فعليًا.",
    cancel: "إلغاء",
    noWorkOrderSelected: "لم يتم اختيار أمر عمل — ارجع واختر واحدًا من القائمة.",

    running: "قيد التشغيل",
    paused: "متوقف مؤقتًا",
    underSetup: "قيد التجهيز",
    pause: "إيقاف مؤقت",
    resume: "استئناف",
    stop: "إيقاف",
    startedAt: "بدأ في {time}",
    setupStartedAt: "بدأ التجهيز في {time}",
    setupThenWorking: "التجهيز {duration} · العمل منذ {time}",
    setupInProgress: "التجهيز جارٍ — ستظهر جداول البيانات عند الضغط على «بدء العمل».",
    addRow: "+ إضافة صف",
    noColumns: "لا توجد أعمدة معدّة هنا بعد — اطلب من المشرف إضافتها في لوحة التحكم.",
    removeRow: "حذف الصف",

    whyPausing: "ما سبب الإيقاف المؤقت؟",
    searchReason: "ابحث بالرمز أو السبب…",
    reason: "السبب",
    noReasons: "لا توجد أسباب معدّة لهذه الماكينة بعد — اطلب من المشرف.",
    nothingMatches: "لا توجد نتائج لـ «{q}».",

    jobFinished: "هل انتهى العمل؟",
    finishedBtn: "مكتمل",
    incomplete: "غير مكتمل / ملغى",
    whatHappened: "ماذا حدث؟",
    addRowsBefore: "أضف صفًا واحدًا على الأقل إلى {names} قبل الإنهاء.",
    stillInSetup: "هذا العمل ما زال في مرحلة التجهيز — اضغط «بدء العمل» أولًا، أو أوقفه كغير مكتمل / ملغى.",

    fieldProcess: "العملية",
    fieldQty: "الكمية",
    fieldDia: "القطر",
    fieldTol: "التفاوت",
    fieldDue: "الاستحقاق",
    priorityNormal: "عادي",
    priorityHigh: "مرتفع",
    priorityUrgent: "عاجل",
    fillRequiredCells: "{screen} الصف {row}: أكمل {fields} قبل الإنهاء.",
    updateReady: "التحديث جاهز — سيُثبَّت عند إغلاق التطبيق",
    updateDownloading: "جارٍ تنزيل التحديث…",
    scrapCode: "الرمز",
    scrapDescription: "الوصف",
    searchFinished: "ابحث في الأعمال المكتملة…",
    scrapNeedsCode: "اختر الرمز وأدخل الوزن لكل صف، أو احذف الصفوف الفارغة.",
    shiftFinish: "إنهاء الوردية",
    shiftFinishTitle: "إنهاء الوردية",
    scrapHint: "سجّل أي هالك من ورديتك قبل تسجيل الخروج.",
    scrap: "الهالك",
    scrapMaterial: "المادة",
    scrapKg: "الوزن (كجم)",
    signOut: "تسجيل الخروج",
    noScrapYet: "لا يوجد هالك مسجّل. أضف صفًا، أو سجّل الخروج بدون هالك.",
    stopJobFirst: "أوقف العمل الجاري قبل إنهاء الوردية.",
    scrapNeedsMaterial: "اختر المادة وأدخل الوزن لكل صف، أو احذف الصفوف الفارغة.",
    dayShift: "الوردية الصباحية",
    nightShift: "الوردية الليلية",

    setupNeeded: "الإعداد مطلوب",
    starting: "جارٍ البدء…",
  },

  hi: {
    _name: "हिन्दी",
    _dir: "ltr",

    synced: "सिंक हो गया",
    syncing: "{n} सिंक हो रहे हैं…",
    offline: "ऑफ़लाइन",
    offlineSaved: "ऑफ़लाइन — {n} स्थानीय रूप से सहेजे गए",

    enterId: "अपना आईडी नंबर दर्ज करें",
    continue: "जारी रखें",
    switchOperator: "ऑपरेटर बदलें",
    operatorLabel: "ऑपरेटर",

    queue: "कार्य सूची",
    finished: "पूर्ण",
    refresh: "रिफ़्रेश",
    noWorkOrders: "इस मशीन के लिए अभी कोई वर्क ऑर्डर नहीं है।",
    askSupervisor: "अपने सुपरवाइज़र से जोड़ने के लिए कहें।",
    nothingFinished: "अभी तक कुछ पूरा नहीं हुआ।",
    alreadyInProgress: "पहले से चल रहा है",
    notYetTopOnly: "अभी नहीं — केवल पहले {n}",
    runningNow: "अभी चल रहा है",
    workOrderList: "वर्क ऑर्डर सूची",
    back: "वापस",

    planChangeTitle: "कृपया जाँचें – योजना में बदलाव",
    planChangeBody: "आपके सुपरवाइज़र ने कार्य योजना बदली है। कुछ भी शुरू करने से पहले सूची रिफ़्रेश करें।",
    refreshNow: "अभी रिफ़्रेश करें",
    dismiss: "बंद करें",
    planChangedBlocked: "योजना बदल गई है — वापस जाकर सूची रिफ़्रेश करें।",

    confirmStart: "क्या आप वाकई यह वर्क ऑर्डर शुरू करना चाहते हैं?",
    startWork: "काम शुरू करें",
    startSetup: "सेटअप शुरू करें",
    startHint: "अगर पहले मशीन सेट करनी है तो «सेटअप शुरू करें» चुनें — वह समय अलग से दर्ज होता है, और उत्पादन शुरू होने पर «काम शुरू करें» दबाएँ।",
    cancel: "रद्द करें",
    noWorkOrderSelected: "कोई वर्क ऑर्डर नहीं चुना — वापस जाकर सूची से एक चुनें।",

    running: "चल रहा है",
    paused: "रुका हुआ",
    underSetup: "सेटअप चल रहा है",
    pause: "रोकें",
    resume: "फिर शुरू करें",
    stop: "बंद करें",
    startedAt: "{time} पर शुरू हुआ",
    setupStartedAt: "सेटअप {time} पर शुरू हुआ",
    setupThenWorking: "सेटअप {duration} · {time} से काम",
    setupInProgress: "सेटअप चल रहा है — «काम शुरू करें» दबाने पर डेटा तालिकाएँ दिखेंगी।",
    addRow: "+ पंक्ति जोड़ें",
    noColumns: "यहाँ अभी कोई कॉलम नहीं है — सुपरवाइज़र से एडमिन पैनल में जोड़ने को कहें।",
    removeRow: "पंक्ति हटाएँ",

    whyPausing: "आप क्यों रोक रहे हैं?",
    searchReason: "कोड या कारण खोजें…",
    reason: "कारण",
    noReasons: "इस मशीन के लिए अभी कोई कारण नहीं है — सुपरवाइज़र से कहें।",
    nothingMatches: "«{q}» से कुछ मेल नहीं खाता।",

    jobFinished: "क्या काम पूरा हो गया?",
    finishedBtn: "पूर्ण",
    incomplete: "अपूर्ण / रद्द",
    whatHappened: "क्या हुआ?",
    addRowsBefore: "पूरा करने से पहले {names} में कम से कम एक पंक्ति जोड़ें।",
    stillInSetup: "यह काम अभी सेटअप में है — पहले «काम शुरू करें» दबाएँ, या इसे अपूर्ण / रद्द के रूप में बंद करें।",

    fieldProcess: "प्रक्रिया",
    fieldQty: "मात्रा",
    fieldDia: "व्यास",
    fieldTol: "सहनशीलता",
    fieldDue: "नियत",
    priorityNormal: "सामान्य",
    priorityHigh: "उच्च",
    priorityUrgent: "अत्यावश्यक",
    fillRequiredCells: "{screen} पंक्ति {row}: पूरा करने से पहले {fields} भरें।",
    updateReady: "अपडेट तैयार — ऐप बंद होने पर इंस्टॉल होगा",
    updateDownloading: "अपडेट डाउनलोड हो रहा है…",
    scrapCode: "कोड",
    scrapDescription: "विवरण",
    searchFinished: "पूर्ण कार्य खोजें…",
    scrapNeedsCode: "हर पंक्ति के लिए कोड चुनें और वज़न दर्ज करें, या खाली पंक्तियाँ हटाएँ।",
    shiftFinish: "शिफ़्ट समाप्त",
    shiftFinishTitle: "शिफ़्ट समाप्त करें",
    scrapHint: "साइन आउट करने से पहले अपनी शिफ़्ट का स्क्रैप दर्ज करें।",
    scrap: "स्क्रैप",
    scrapMaterial: "सामग्री",
    scrapKg: "वज़न (कि.ग्रा.)",
    signOut: "साइन आउट",
    noScrapYet: "कोई स्क्रैप दर्ज नहीं। पंक्ति जोड़ें, या बिना स्क्रैप साइन आउट करें।",
    stopJobFirst: "शिफ़्ट समाप्त करने से पहले चल रहे काम को बंद करें।",
    scrapNeedsMaterial: "हर पंक्ति के लिए सामग्री चुनें और वज़न दर्ज करें, या खाली पंक्तियाँ हटाएँ।",
    dayShift: "दिन की शिफ़्ट",
    nightShift: "रात की शिफ़्ट",

    setupNeeded: "सेटअप आवश्यक",
    starting: "शुरू हो रहा है…",
  },
};

const LANGUAGES = Object.keys(STRINGS).map((code) => ({
  code,
  name: STRINGS[code]._name,
  dir: STRINGS[code]._dir,
}));

let currentLang = "en";

function setLanguage(code) {
  currentLang = STRINGS[code] ? code : "en";
  document.documentElement.lang = currentLang;
  document.documentElement.dir = STRINGS[currentLang]._dir;
  return currentLang;
}
function getLanguage() {
  return currentLang;
}

// Look up a key, falling back to English and finally to the key itself, so
// a missing translation never renders as a blank or a raw identifier.
// {placeholders} are substituted from `vars`.
function t(key, vars) {
  const raw = STRINGS[currentLang]?.[key] ?? STRINGS.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}
