import type { ErrorCode } from "../src/contracts";
import { AppError } from "../src/errors";

export type Language = "en" | "ar";
export type Message = { en: string; ar: string };
export const bilingual = (en: string, ar: string): Message => ({ en, ar });

const arabic = {
  "": "",
  "WhatsApp email drafts": "مسودات البريد من واتساب",
  "Turn a WhatsApp export into one editable email.": "حوّل محادثة واتساب المصدّرة إلى رسالة بريد قابلة للتعديل.",
  "Generate email": "أنشئ رسالة بريد",
  "Paste WhatsApp export": "ألصق محادثة واتساب المصدّرة",
  "Or upload WhatsApp export (.txt)": "أو ارفع ملف محادثة واتساب (.txt)",
  "Choose file": "اختر ملفًا",
  "No file chosen": "لم تختر ملفًا",
  "Clear export": "امسح المحادثة",
  "Use pasted text or a .txt file. Clear the export to switch. The full export is processed and is not saved.": "ألصق النص أو اختر ملفًا بصيغة .txt. امسح المحادثة لتغيير طريقة الإدخال. تُعالج المحادثة كاملة دون حفظها.",
  "Loading configuration…": "جارٍ تحميل الإعدادات…",
  "Cancel generation": "ألغِ الإنشاء",
  "Retry configuration": "أعد تحميل الإعدادات",
  "Email draft": "مسودة البريد",
  "Not generated": "لم تُنشأ مسودة بعد",
  "Paste or upload an export to create a draft, or open a saved version.": "ألصق محادثة أو ارفع ملفها لإنشاء مسودة، أو افتح نسخة محفوظة.",
  "Subject": "الموضوع",
  "Email body": "نص الرسالة",
  "Save draft": "احفظ المسودة",
  "Save changes": "احفظ التغييرات",
  "Copy email": "انسخ الرسالة",
  "Regenerate": "أعد الإنشاء",
  "Regenerate uses the current export and creates a new unsaved draft. Saved versions stay in history.": "تُنشئ إعادة الإنشاء مسودة جديدة غير محفوظة من المحادثة الحالية. تبقى النسخ المحفوظة في السجل.",
  "Saved history": "سجل المسودات",
  "Refresh": "حدّث السجل",
  "Only drafts you explicitly save appear here.": "تظهر هنا المسودات التي تحفظها فقط.",
  "Saving…": "جارٍ الحفظ…",
  "Unsaved changes": "تغييرات غير محفوظة",
  "Unsaved draft": "مسودة غير محفوظة",
  "The connection failed. Check your connection and try again.": "تعذر الاتصال. تحقق من اتصالك وحاول مجددًا.",
  "Wait for the current save to finish before replacing this draft.": "انتظر اكتمال الحفظ قبل استبدال هذه المسودة.",
  "Replace unsaved work? Any edits not saved will be lost.": "هل تريد استبدال المسودة؟ ستفقد التغييرات غير المحفوظة.",
  "Choose a nonempty .txt WhatsApp export.": "اختر ملف محادثة واتساب غير فارغ بصيغة .txt.",
  "Paste an export or choose a .txt file, not both.": "ألصق المحادثة أو اختر ملفًا بصيغة .txt، وليس كليهما.",
  "Reading the export…": "جارٍ قراءة المحادثة…",
  "Email ready. Review and edit below.": "الرسالة جاهزة. راجعها وعدّلها أدناه.",
  "Generation failed. Your previous draft is unchanged. Try again.": "تعذر إنشاء الرسالة. مسودتك السابقة لم تتغير. حاول مجددًا.",
  "Subject and body copied. Paste into your email app to send manually.": "نُسخ الموضوع ونص الرسالة. ألصقهما في تطبيق البريد لإرسالهما يدويًا.",
  "Clipboard unavailable. Select and copy the subject and body manually.": "تعذر النسخ. حدّد الموضوع ونص الرسالة وانسخهما يدويًا.",
  "Loading saved drafts…": "جارٍ تحميل المسودات المحفوظة…",
  "Delete": "احذف",
  "No saved drafts yet.": "لا توجد مسودات محفوظة بعد.",
  "Saved draft opened. Paste or upload an export to regenerate.": "فُتحت المسودة المحفوظة. ألصق محادثة أو ارفع ملفها لإعادة الإنشاء.",
  "Saved version deleted · unsaved draft retained": "حُذفت النسخة المحفوظة · احتُفظ بالمسودة دون حفظ",
  "Ready to process the full export.": "جاهز لمعالجة المحادثة كاملة.",
  "Configuration unavailable.": "تعذر تحميل الإعدادات.",
  "Generation cancelled. Your previous draft is unchanged.": "أُلغي إنشاء الرسالة. مسودتك السابقة لم تتغير.",
} as const;

export type TextKey = keyof typeof arabic;
export const text = (key: TextKey): Message => bilingual(key, arabic[key]);

const errors: Record<ErrorCode, string> = {
  CONFIGURATION_ERROR: "إعدادات التطبيق غير صحيحة. تحقق من الإعدادات المطلوبة.",
  INVALID_REQUEST: "الطلب غير صحيح. تحقق من الحقول المطلوبة.",
  UPLOAD_TOO_LARGE: "حجم الملف يتجاوز الحد المحدد. استخدم ملفًا أصغر أو ارفع الحد.",
  TRANSCRIPT_TOO_LARGE: "المحادثة تتجاوز عدد الأحرف المسموح به. استخدم محادثة أقصر أو ارفع الحد.",
  MESSAGE_TOO_LARGE: "إحدى الرسائل تتجاوز الحد المحدد. ارفع الحد لمعالجتها كاملة.",
  PARSE_ERROR: "تعذر قراءة المحادثة. تحقق من تنسيق واتساب والتواريخ بصيغة يوم/شهر/سنة.",
  MODEL_OUTPUT_TOO_LARGE: "استجابة النموذج تتجاوز حد المخرجات. ارفع الحد وحاول مجددًا.",
  SYNTHESIS_INPUT_TOO_LARGE: "المحتوى الكامل يتجاوز حد المعالجة. ارفع الحد للاحتفاظ بجميع المحادثات.",
  MODEL_UNAVAILABLE: "خدمة النموذج غير متاحة مؤقتًا. حاول مجددًا.",
  MODEL_TIMEOUT: "انتهت مهلة استجابة النموذج. حاول مجددًا.",
  MODEL_REQUEST_FAILED: "رفضت خدمة النموذج الطلب. تحقق من إعدادات النموذج.",
  INVALID_MODEL_RESPONSE: "أعاد النموذج نتيجة غير صالحة. حاول مجددًا.",
  CANCELLED: "أُلغي الطلب.",
  NOT_FOUND: "العنصر المطلوب غير موجود.",
  METHOD_NOT_ALLOWED: "طريقة الطلب هذه غير مدعومة.",
  STORAGE_ERROR: "المسودات المحفوظة غير متاحة مؤقتًا. حاول مجددًا.",
  INVALID_STREAM: "انتهى إنشاء الرسالة بنتيجة ناقصة أو غير صالحة. حاول مجددًا.",
  INTERNAL_ERROR: "حدث خطأ غير متوقع في التطبيق.",
};

export function errorMessage(error: unknown): Message {
  return error instanceof AppError ? bilingual(error.message, errors[error.code])
    : text("The connection failed. Check your connection and try again.");
}

export const savedStatus = (revision: number): Message => bilingual(`Saved · revision ${revision}`, `محفوظة · المراجعة ${revision}`);
