import os
import google.generativeai as genai
from dotenv import load_dotenv
import sys
from PIL import Image
import glob
import json

# --- المسارات الديناميكية ---
# سيتم تحديدها بناءً على اسم المشروع
PROJECT_NAME = None
BASE_PROJECTS_DIR = "projects"
INPUT_FOLDER = None
OUTPUT_FOLDER = None
GLOSSARY_FILE = None
FINAL_FILENAME = "full_chapter_translation.txt"

def setup_project_paths(project_name):
    """إعداد المسارات بناءً على اسم المشروع المُعطى."""
    global PROJECT_NAME, INPUT_FOLDER, OUTPUT_FOLDER, GLOSSARY_FILE
    PROJECT_NAME = project_name
    project_dir = os.path.join(BASE_PROJECTS_DIR, PROJECT_NAME)
    
    INPUT_FOLDER = os.path.join(project_dir, "input_images")
    OUTPUT_FOLDER = os.path.join(project_dir, "output_translations")
    GLOSSARY_FILE = os.path.join(project_dir, "glossary.json")
    
    # إنشاء المجلدات الضرورية للمشروع إذا لم تكن موجودة
    os.makedirs(INPUT_FOLDER, exist_ok=True)
    os.makedirs(OUTPUT_FOLDER, exist_ok=True)
    print(f"🗂️ تم تحديد المشروع: '{PROJECT_NAME}'. سيتم استخدام المسارات داخل مجلده الخاص.")

def load_glossary():
    if not os.path.exists(GLOSSARY_FILE):
        with open(GLOSSARY_FILE, 'w', encoding='utf-8') as f:
            json.dump({}, f)
        return {}
    try:
        with open(GLOSSARY_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        return {}

def save_glossary(glossary_data):
    with open(GLOSSARY_FILE, 'w', encoding='utf-8') as f:
        json.dump(glossary_data, f, ensure_ascii=False, indent=4)

# --- باقي الدوال (translate_image, find_and_update_new_terms) تبقى كما هي ---
def translate_image(image_path, model, glossary, previous_page_translation):
    print(f"\n--- ⏳ جاري معالجة الصورة: {os.path.basename(image_path)} ---")
    img = Image.open(image_path)
    glossary_text = "\n".join([f"- {k}: {v}" for k, v in glossary.items()])
    context_section = ""
    if previous_page_translation:
        context_section = f"""
**القاعدة الثانية: انتبه للسياق الكامل!**
هذه هي الترجمة الكاملة للصفحة السابقة. استخدمها كسياق لفهم القصة وترجمة الصفحة الحالية بشكل صحيح:
--- بداية سياق الصفحة السابقة ---
{previous_page_translation}
--- نهاية سياق الصفحة السابقة ---
"""
    translation_prompt = f"""
أنت خبير ومترجم مانهوا محترف. انظر إلى الصورة المرفقة وقم بما يلي:
**القاعدة الأولى والأساسية: التزم بالمسرد التالي بشكل إلزامي:**
--- بداية المسرد ---
{glossary_text}
--- نهاية المسرد ---
{context_section}
**بقية القواعد:**
قم فقط بما هو مطلوب أدناه بدون إضافة أي كلام زائد أو توضيحات إضافية، ولا تستخدم أي تنسيقات مثل النجوم أو الماركداون أو أي شكل آخر من أشكال التنسيق في إجابتك.

استخرج النص الكوري أو الإنجليزي الموجود داخل كل فقاعة حوار بشكل منفصل. لا تدمج النصوص من فقاعات مختلفة. الفقاعة تُترجم كاملة بدون فصل ولا تدمج بين الفقاعات.

ترجم كل نص كوري أو إنجليزي إلى اللغة العربية بالخطوات التالية وبالترتيب:

الكورية أو الإنجليزية: اكتب النص الكوري الأصلي أو الإنجليزي الذي استخرجته.
الترجمة الحرفية: اكتب الترجمة الحرفية دون قطع.
الترجمة الأدبية العربية: اكتب ترجمة أدبية عميقة صحيحة نحويًا ولغويًا، مع استخدام علامات الترقيم المناسبة والمصطلحات الشائعة لإيصال المعنى بأفضل شكل للقارئ العربي.

إذا كانت الصورة كبيرة وفيها أكثر من فقاعة اجعل الترجمة مناسبة للسياق. ترجم فقط الفقاعات ولا تترجم الأصوات.
إذا وجدت نصًا خارج فقاعات الحوار، قم بترجمته بنفس الخطوات أعلاه لكن أضف في بداية السطر عبارة «تنبيه: نص خارج فقاعة».
اجعل المخرج النهائي منظمًا وموجهًا من اليمين إلى اليسار وبدون أي تنسيق أو علامات خاصة.
    """
    response = model.generate_content([translation_prompt, img])
    return response.text

def find_and_update_new_terms(text_to_analyze, model, glossary):
    print("--- 🧠 البحث عن مصطلحات جديدة لتحديث المسرد...")
    extraction_prompt = f"""
    أنت مساعد متخصص في تحليل النصوص. انظر إلى النص التالي.
    هل يحتوي النص على أي أسماء شخصيات، أماكن، أو مصطلحات مهمة لم تكن موجودة في المسرد الأصلي؟
    **المسرد الأصلي:** {list(glossary.keys())}
    **النص للتحليل:** {text_to_analyze}
    **المطلوب:** إذا وجدت مصطلحات جديدة، أرجعها فقط بتنسيق JSON. إذا لم تجد شيئًا، أرجع {{}}.
    مثال: {{"New Term 1": "Translation 1", "New Term 2": "Translation 2"}}
    """
    response = model.generate_content(extraction_prompt)
    try:
        clean_response = response.text.strip().replace('```json', '').replace('```', '')
        new_terms = json.loads(clean_response)
        if new_terms:
            updated_count = 0
            for term, translation in new_terms.items():
                if term not in glossary:
                    glossary[term] = translation
                    updated_count += 1
            if updated_count > 0:
                print(f"✅ تم العثور على {updated_count} مصطلح جديد وإضافتها للمسرد.")
                save_glossary(glossary)
            else:
                print("--- لم يتم العثور على مصطلحات جديدة.")
        else:
            print("--- لم يتم العثور على مصطلحات جديدة.")
    except (json.JSONDecodeError, AttributeError) as e:
        print(f"[تحذير] لم يتمكن من تحليل المصطلحات الجديدة. الخطأ: {e}")

def main():
    # --- التحقق من وجود اسم المشروع ---
    if len(sys.argv) < 2:
        print("❌ خطأ: يرجى تحديد اسم المشروع عند تشغيل السكربت.")
        print("مثال: python3 run_translator.py solo-leveling")
        sys.exit(1)
    
    project_name_arg = sys.argv[1]
    setup_project_paths(project_name_arg)

    # --- بقية الدالة main تعمل كالسابق ولكن على المسارات الجديدة ---
    load_dotenv()
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("[خطأ] لم يتم العثور على مفتاح GOOGLE_API_KEY.")
        sys.exit(1)
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel('gemini-2.5-flash')
    print("✅ Gemini API جاهز للعمل.")

    glossary = load_glossary()
    print(f"✅ تم تحميل المسرد الخاص بالمشروع '{PROJECT_NAME}' ويحتوي على {len(glossary)} مصطلح.")

    image_paths = sorted(glob.glob(os.path.join(INPUT_FOLDER, '*.*')))
    if not image_paths:
        print(f"لم يتم العثور على أي صور في المجلد '{INPUT_FOLDER}'.")
        sys.exit(0)
    print(f"✅ تم العثور على {len(image_paths)} صورة. ستبدأ عملية الترجمة...")

    all_translations_for_final_file = []
    previous_page_full_translation = None

    for path in image_paths:
        translation = translate_image(path, model, glossary, previous_page_full_translation)
        
        base_name = os.path.basename(path)
        file_name_without_ext = os.path.splitext(base_name)[0]
        output_path = os.path.join(OUTPUT_FOLDER, f"{file_name_without_ext}.txt")
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(translation)
        print(f"✅ تم حفظ الترجمة المنفصلة في: {output_path}")
        
        find_and_update_new_terms(translation, model, glossary)
        
        previous_page_full_translation = translation
        print(f"--- ✅ تم حفظ سياق الصفحة الكاملة للمرة القادمة.")
        
        page_separator = f"\n\n--- نهاية ترجمة صفحة: {base_name} ---\n\n"
        all_translations_for_final_file.append(translation + page_separator)

    final_output_path = os.path.join(OUTPUT_FOLDER, FINAL_FILENAME)
    with open(final_output_path, 'w', encoding='utf-8') as f:
        f.write("\n".join(all_translations_for_final_file))
    
    print(f"\n✅ تم حفظ الملف المجمع للفصل بالكامل في: {final_output_path}")
    print("\n🎉🎉🎉 اكتملت ترجمة جميع الصور بنجاح! 🎉🎉🎉")

if __name__ == "__main__":
    main()
