import { supabase } from '../lib/supabase.js';
import { showToast } from '../lib/feedback.js';
import { escapeHtml } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { adminDeletePage, adminExtendSubscription, adminBanUser, adminUnbanUser, adminUpdatePage, publicPageUrl } from '../lib/pages-api.js';
import { isValidConversionLabel } from '../lib/page-validation.js';

export async function renderAdmin(container) {
  container.innerHTML = `
    <div class="min-h-screen bg-slate-950 p-6 flex items-center justify-center text-slate-400">
      <div class="animate-pulse flex items-center gap-3">
        <i class="fa-solid fa-circle-notch fa-spin text-emerald-500 text-2xl"></i>
        <span>جاري فتح لوحة المدير...</span>
      </div>
    </div>
  `;

  const [pagesRes, bansRes] = await Promise.all([
    supabase.from('pages').select('*').order('created_at', { ascending: false }),
    supabase.from('banned_users').select('user_id'),
  ]);

  if (pagesRes.error || bansRes.error) {
    console.error(pagesRes.error || bansRes.error);
    container.innerHTML = `
      <div class="min-h-screen bg-slate-950 p-6 flex items-center justify-center">
        <div class="max-w-sm text-center space-y-4">
          <p class="text-rose-400 font-bold">تعذر تحميل الصفحات. تحقق من اتصالك ثم أعد المحاولة.</p>
          <button id="retryAdmin" type="button" class="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black px-6 py-3 rounded-xl cursor-pointer">إعادة المحاولة</button>
        </div>
      </div>
    `;
    container.querySelector('#retryAdmin').addEventListener('click', () => renderAdmin(container));
    return;
  }

  const allPages = pagesRes.data || [];
  const bannedIds = new Set((bansRes.data || []).map((row) => row.user_id));

  const now = new Date();

  const pagesWithStatus = allPages.map((page) => {
    let diffDays = 0;
    let isExpired = false;
    let isExpiringSoon = false;

    if (page.expires_at) {
      diffDays = Math.ceil((new Date(page.expires_at) - now) / (1000 * 60 * 60 * 24));
      if (diffDays <= 0) isExpired = true;
      else if (diffDays <= 7) isExpiringSoon = true;
    }

    return { ...page, diffDays, isExpired, isExpiringSoon };
  });

  const totalPages = pagesWithStatus.length;
  const suspendedCount = pagesWithStatus.filter((p) => p.is_active === false).length;
  const activeCount = pagesWithStatus.filter((p) => !p.isExpired && p.is_active !== false).length;
  const expiringSoonCount = pagesWithStatus.filter((p) => p.isExpiringSoon && p.is_active !== false).length;
  const expiredCount = pagesWithStatus.filter((p) => p.isExpired).length;
  const trialCount = pagesWithStatus.filter((p) => p.is_trial === true && !p.isExpired).length;

  container.innerHTML = `
    <div class="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 max-w-6xl mx-auto">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 class="text-3xl font-black flex items-center gap-3">
            <i class="fa-solid fa-crown text-emerald-500"></i> لوحة إدارة صفحة إعلان (PAG ADS)
          </h1>
          <p class="text-slate-400 text-sm mt-1">التحكم الكامل في العملاء والاشتراكات والأسعار المباشرة.</p>
        </div>

        <button
          id="openPricingBtn"
          class="py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 border border-emerald-500/40 text-emerald-400 font-bold text-xs flex items-center gap-2 transition active:scale-95 cursor-pointer"
        >
          <i class="fa-solid fa-tags"></i>
          <span>التحكم في الأسعار والباقات</span>
        </button>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-6 gap-4 mb-8">
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <div class="text-xs font-bold text-slate-400">إجمالي الصفحات</div>
          <div class="text-2xl font-black text-slate-100 mt-1">${totalPages}</div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <div class="text-xs font-bold text-emerald-400">النشطة</div>
          <div class="text-2xl font-black text-emerald-400 mt-1">${activeCount}</div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <div class="text-xs font-bold text-amber-400">قريبة الانتهاء</div>
          <div class="text-2xl font-black text-amber-400 mt-1">${expiringSoonCount}</div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <div class="text-xs font-bold text-purple-400">تجريبية</div>
          <div class="text-2xl font-black text-purple-400 mt-1">${trialCount}</div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <div class="text-xs font-bold text-rose-400">موقوفة</div>
          <div class="text-2xl font-black text-rose-400 mt-1">${suspendedCount}</div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <div class="text-xs font-bold text-rose-400">منتهية</div>
          <div class="text-2xl font-black text-rose-400 mt-1">${expiredCount}</div>
        </div>
      </div>

      <div class="flex flex-col sm:flex-row items-center justify-between gap-4 mb-6">
        <div class="relative w-full sm:w-80">
          <i class="fa-solid fa-magnifying-glass absolute right-3 top-3.5 text-slate-500 text-sm"></i>
          <input
            type="text"
            id="searchInput"
            placeholder="بحث بالاسم أو الهاتف أو الرابط..."
            class="w-full bg-slate-900 border border-slate-800 rounded-xl pr-9 pl-4 py-2.5 text-sm text-slate-200 outline-none focus:border-emerald-500"
          />
        </div>

        <div class="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <button class="filter-btn px-4 py-2 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950" data-filter="all">
            الكل (${totalPages})
          </button>

          <button class="filter-btn px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-slate-300 hover:bg-slate-800" data-filter="active">
            النشطة (${activeCount})
          </button>

          <button class="filter-btn px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-slate-300 hover:bg-slate-800" data-filter="expiring">
            قريبة الانتهاء (${expiringSoonCount})
          </button>

          <button class="filter-btn px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-slate-300 hover:bg-slate-800" data-filter="trial">
            تجريبية (${trialCount})
          </button>

          <button class="filter-btn px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-slate-300 hover:bg-slate-800" data-filter="suspended">
            موقوفة (${suspendedCount})
          </button>

          <button class="filter-btn px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-slate-300 hover:bg-slate-800" data-filter="expired">
            المنتهية (${expiredCount})
          </button>
        </div>
      </div>

      <div id="pagesList" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>

      <div
        id="editModal"
        class="fixed inset-0 bg-slate-950/80 backdrop-blur-md hidden items-center justify-center p-4 z-50"
      >
        <div class="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full p-6 shadow-2xl animate-fade-in max-h-[90vh] overflow-y-auto">
          <div class="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
            <h3 class="text-lg font-bold text-slate-100 flex items-center gap-2">
              <i class="fa-solid fa-pen-to-square text-emerald-500"></i> تعديل بيانات وقالب الصفحة
            </h3>
            <button id="closeModalBtn" class="text-slate-400 hover:text-slate-200 text-xl">&times;</button>
          </div>

          <form id="editForm" class="space-y-4">
            <input type="hidden" id="editPageId" />

            <div>
              <label class="block text-xs font-bold text-slate-400 mb-1">اختيار قالب التصميم</label>
              <select
                id="editTheme"
                class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none"
              >
                <option value="emerald">🟢 سبيد الزمردي (الأكثر سرعة وطلبًا)</option>
                <option value="blue">🔵 الأزرق الموثوق (طابع شركات ومؤسسات)</option>
                <option value="gold">🟡 الذهبي الفاخر (VIP خدمات راقية)</option>
              </select>
            </div>

            <div>
              <label class="block text-xs font-bold text-slate-400 mb-1">اسم النشاط / عنوان الصفحة</label>
              <input
                type="text"
                id="editTitle"
                class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none"
                required
              />
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-bold text-slate-400 mb-1">رقم الهاتف للاتصال</label>
                <input
                  type="text"
                  id="editPhone"
                  class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none font-mono"
                  required
                />
              </div>
              <div>
                <label class="block text-xs font-bold text-slate-400 mb-1">الرابط (Slug) - لا يمكن تغييره</label>
                <input
                  type="text"
                  id="editSlug"
                  class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-400 text-sm outline-none font-mono cursor-not-allowed"
                  readonly
                />
              </div>
            </div>

            <div>
              <label class="block text-xs font-bold text-slate-400 mb-1">تاريخ انتهاء الاشتراك</label>
              <input
                type="date"
                id="editExpiresAt"
                class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none font-mono"
                required
              />
            </div>

            <div>
              <label class="block text-xs font-bold text-slate-400 mb-1">حالة الصفحة</label>
              <select
                id="editIsActive"
                class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none"
              >
                <option value="true">مفعلة</option>
                <option value="false">موقوفة من الإدارة</option>
              </select>
            </div>

            <div>
              <label class="block text-xs font-bold text-slate-400 mb-1">نوع الاشتراك</label>
              <select
                id="editIsTrial"
                class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none"
              >
                <option value="false">اشتراك مدفوع</option>
                <option value="true">فترة تجريبية</option>
              </select>
            </div>

            <div>
              <label class="block text-xs font-bold text-slate-400 mb-1">وصف الخدمة</label>
              <textarea
                id="editDescription"
                rows="3"
                class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none"
              ></textarea>
            </div>

            <div>
              <label class="block text-xs font-bold text-slate-400 mb-1">أوقات العمل الظاهرة للزائر</label>
              <input
                type="text"
                id="editWorkingHours"
                placeholder="مثال: من 4 عصرًا إلى 10 مساءً"
                class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none"
              />
            </div>

            <div>
              <label class="block text-xs font-bold text-slate-400 mb-1">كود تتبع إعلانات جوجل (gtag)</label>
              <input
                type="text"
                id="editGtag"
                placeholder="AW-123456789/AbC_DeF"
                class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none font-mono"
              />
            </div>

            <details class="bg-slate-950 border border-slate-800 rounded-xl p-3">
              <summary class="text-xs font-bold text-emerald-400 cursor-pointer">
                روابط التواصل الاجتماعي
              </summary>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <div>
                  <label class="block text-[11px] font-bold text-slate-400 mb-1">واتساب</label>
                  <input
                    type="text"
                    id="editWhatsapp"
                    dir="ltr"
                    class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-100 outline-none focus:border-emerald-500 font-mono"
                  />
                </div>

                <div>
                  <label class="block text-[11px] font-bold text-slate-400 mb-1">انستجرام</label>
                  <input
                    type="text"
                    id="editInstagram"
                    dir="ltr"
                    class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-100 outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label class="block text-[11px] font-bold text-slate-400 mb-1">سناب شات</label>
                  <input
                    type="text"
                    id="editSnapchat"
                    dir="ltr"
                    class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-100 outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label class="block text-[11px] font-bold text-slate-400 mb-1">تيك توك</label>
                  <input
                    type="text"
                    id="editTiktok"
                    dir="ltr"
                    class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-100 outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
            </details>

            <div class="pt-4 flex gap-3">
              <button
                type="submit"
                class="flex-1 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition cursor-pointer"
              >
                حفظ التعديلات
              </button>
              <button
                type="button"
                id="cancelModalBtn"
                class="px-5 py-3 rounded-xl bg-slate-800 text-slate-300 font-bold text-sm cursor-pointer"
              >
                إلغاء
              </button>
            </div>
          </form>
        </div>
      </div>

    </div>
  `;

  const renderCards = (items) => {
    const list = container.querySelector('#pagesList');

    if (items.length === 0) {
      list.innerHTML = `<div class="col-span-full text-center py-12 text-slate-500">لا توجد صفحات مطابقة للبحث.</div>`;
      return;
    }

    list.innerHTML = items
      .map((page) => {
        const isSuspended = page.is_active === false;
        const isExp = page.isExpired;
        const isTrial = page.is_trial === true;

        let statusText;
        let statusBadge;

        if (isSuspended) {
          statusText = 'موقوفة من الإدارة';
          statusBadge = 'bg-rose-500/10 text-rose-400 border-rose-500/20';
        } else if (isExp) {
          statusText = 'منتهي الصلاحية';
          statusBadge = 'bg-rose-500/10 text-rose-400 border-rose-500/20';
        } else if (isTrial) {
          statusText = `تجريبية - متبقي ${page.diffDays} يوم`;
          statusBadge = 'bg-purple-500/10 text-purple-400 border-purple-500/20';
        } else {
          statusText = `متبقي ${page.diffDays} يوم`;
          statusBadge = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
        }

        const themeNames = { emerald: 'الزمردي 🟢', blue: 'الأزرق 🔵', gold: 'الذهبي 🟡' };
        const currentThemeName = themeNames[page.theme] || 'الزمردي 🟢';

        const safeTitle = escapeHtml(page.title || page.company_name || 'بدون اسم');
        const safeSlug = escapeHtml(page.slug || '');
        const safePhone = escapeHtml(page.phone || '-');
        const cleanPhone = String(page.phone || '').replace(/\D/g, '');

        const waMsg = encodeURIComponent(
          `مرحبًا بك عزيزي في ${page.title || 'خدمتكم'}، نود تذكيركم بخصوص تجديد باقة صفحة الهبوط (${page.slug}). للتجديد ومتابعة استقبال الاتصالات يرجى التواصل معنا.`,
        );

        const waLink = cleanPhone ? `https://wa.me/${cleanPhone}?text=${waMsg}` : '';

        return `
          <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col justify-between hover:border-slate-700 transition">
            <div>
              <div class="flex items-start justify-between gap-3 mb-2">
                <div>
                  <h3 class="font-bold text-lg text-slate-100">${safeTitle}</h3>
                  <a
                    href="${escapeHtml(publicPageUrl(page.slug || '', { returnTo: 'admin' }))}"
                    class="text-xs text-emerald-400 hover:underline flex items-center gap-1 mt-0.5"
                  >
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> /?p=${safeSlug}
                  </a>
                </div>

                <span class="px-2.5 py-1 rounded-full border text-xs font-bold ${statusBadge}">
                  ${escapeHtml(statusText)}
                </span>
              </div>

              <div class="grid grid-cols-2 gap-2 my-4 text-xs text-slate-400 bg-slate-950 p-3 rounded-xl border border-slate-800/80">
                <div>الهاتف: <b class="text-slate-200 font-mono">${safePhone}</b></div>
                <div>القالب: <b class="text-slate-200">${escapeHtml(currentThemeName)}</b></div>
                <div>المشاهدات: <b class="text-slate-200 font-mono">${Number(page.views_count || 0)}</b></div>
                <div>الاتصالات: <b class="text-emerald-400 font-mono">${Number(page.calls_count || 0)}</b></div>
              </div>
            </div>

            <div class="flex items-center gap-2 pt-2 border-t border-slate-800/60">
              <button
                class="edit-btn flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                data-id="${escapeHtml(page.id)}"
              >
                <i class="fa-solid fa-pen-to-square"></i> تعديل
              </button>

              <button
                class="extend-btn py-2 px-3 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                data-id="${escapeHtml(page.id)}"
              >
                <i class="fa-solid fa-calendar-plus"></i> +30 يوم
              </button>

              ${
                waLink
                  ? `
                    <a
                      href="${escapeHtml(waLink)}"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="py-2 px-3 bg-slate-800 hover:bg-emerald-950 text-emerald-400 rounded-xl text-xs font-bold flex items-center justify-center gap-1"
                      title="إرسال تذكير واتساب"
                    >
                      <i class="fa-brands fa-whatsapp text-sm"></i> تذكير
                    </a>
                  `
                  : ''
              }
            </div>

            <div class="flex flex-wrap items-center gap-2 pt-3 mt-3 border-t border-slate-800/60">
              ${
                bannedIds.has(page.user_id)
                  ? `<button class="unban-btn py-2 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer" data-user-id="${escapeHtml(page.user_id)}"><i class="fa-solid fa-user-check"></i> رفع الحظر عن الحساب</button>`
                  : `<button class="ban-btn py-2 px-3 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer" data-id="${escapeHtml(page.id)}" data-title="${safeTitle}"><i class="fa-solid fa-user-slash"></i> حظر الحساب</button>`
              }
              <button class="delete-btn py-2 px-3 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer" data-id="${escapeHtml(page.id)}" data-title="${safeTitle}"><i class="fa-solid fa-trash-can"></i> حذف الصفحة</button>
            </div>
          </div>
        `;
      })
      .join('');

    attachActions();
  };

  const attachActions = () => {
    container.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm(`حذف الصفحة "${btn.dataset.title}" نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`)) return;

        const { error } = await adminDeletePage(btn.dataset.id);

        if (error) {
          console.error(error);
          showToast('تعذر حذف الصفحة', 'error');
          return;
        }

        showToast('تم حذف الصفحة', 'success');
        await renderAdmin(container);
      });
    });

    container.querySelectorAll('.ban-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm(`حظر حساب صاحب الصفحة "${btn.dataset.title}"؟ سيتم إيقاف جميع صفحاته ومنعه من التعديل.`)) return;

        const { error } = await adminBanUser(btn.dataset.id);

        if (error) {
          console.error(error);
          showToast('تعذر حظر الحساب', 'error');
          return;
        }

        showToast('تم حظر الحساب وإيقاف صفحاته', 'success');
        await renderAdmin(container);
      });
    });

    container.querySelectorAll('.unban-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('رفع الحظر عن هذا الحساب؟ ستبقى صفحاته موقوفة حتى تفعّلها يدويًا.')) return;

        const { error } = await adminUnbanUser(btn.dataset.userId);

        if (error) {
          console.error(error);
          showToast('تعذر رفع الحظر', 'error');
          return;
        }

        showToast('تم رفع الحظر عن الحساب', 'success');
        await renderAdmin(container);
      });
    });

    container.querySelectorAll('.edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const page = pagesWithStatus.find((p) => String(p.id) === String(btn.dataset.id));
        if (!page) return;

        container.querySelector('#editPageId').value = page.id;
        container.querySelector('#editTheme').value = page.theme || 'emerald';
        container.querySelector('#editTitle').value = page.title || page.company_name || '';
        container.querySelector('#editPhone').value = page.phone || '';
        container.querySelector('#editSlug').value = page.slug || '';
        container.querySelector('#editDescription').value = page.description || '';
        container.querySelector('#editGtag').value = page.gtag_label || page.conversion_label || '';
        container.querySelector('#editWorkingHours').value = page.working_hours || '';
        container.querySelector('#editIsActive').value = page.is_active === false ? 'false' : 'true';
        container.querySelector('#editIsTrial').value = page.is_trial === true ? 'true' : 'false';

        const social = page.social_links || {};
        container.querySelector('#editWhatsapp').value = page.whatsapp || social.whatsapp || '';
        container.querySelector('#editInstagram').value = page.instagram || social.instagram || '';
        container.querySelector('#editSnapchat').value = page.snapchat || social.snapchat || '';
        container.querySelector('#editTiktok').value = page.tiktok || social.tiktok || '';

        container.querySelector('#editExpiresAt').value = page.expires_at
          ? new Date(page.expires_at).toISOString().split('T')[0]
          : '';

        const modal = container.querySelector('#editModal');
        modal.classList.remove('hidden');
        modal.classList.add('flex');
      });
    });

    container.querySelectorAll('.extend-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const { error } = await adminExtendSubscription(btn.dataset.id, 30);

        if (error) {
          console.error(error);
          showToast('تعذر تمديد الاشتراك', 'error');
          return;
        }

        const extended = allPages.find((p) => p.id === btn.dataset.id);
        if (extended?.is_active === false) {
          showToast('تم تمديد الاشتراك 30 يومًا. الصفحة ما زالت موقوفة، فعّلها من زر التعديل', 'success');
        } else {
          showToast('تم تمديد الاشتراك 30 يومًا', 'success');
        }
        await renderAdmin(container);
      });
    });
  };

  const editModal = container.querySelector('#editModal');
  const closeEditModal = () => {
    editModal.classList.add('hidden');
    editModal.classList.remove('flex');
  };

  container.querySelector('#closeModalBtn').addEventListener('click', closeEditModal);
  container.querySelector('#cancelModalBtn').addEventListener('click', closeEditModal);

  container.querySelector('#openPricingBtn').addEventListener('click', () => navigate('admin-pricing'));

  container.querySelector('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const id = container.querySelector('#editPageId').value;
    const theme = container.querySelector('#editTheme').value;
    const title = container.querySelector('#editTitle').value.trim();
    const phone = container.querySelector('#editPhone').value.trim();
    const description = container.querySelector('#editDescription').value.trim();
    const gtag_label = container.querySelector('#editGtag').value.trim();
    const working_hours = container.querySelector('#editWorkingHours').value.trim();
    const is_active = container.querySelector('#editIsActive').value === 'true';
    const is_trial = container.querySelector('#editIsTrial').value === 'true';

    const whatsapp = container.querySelector('#editWhatsapp').value.trim();
    const instagram = container.querySelector('#editInstagram').value.trim();
    const snapchat = container.querySelector('#editSnapchat').value.trim();
    const tiktok = container.querySelector('#editTiktok').value.trim();

    const expiresInput = container.querySelector('#editExpiresAt').value;

    if (!title || !phone || !expiresInput) {
      showToast('أكمل الحقول المطلوبة', 'error');
      return;
    }

    if (gtag_label && !isValidConversionLabel(gtag_label)) {
      showToast('كود جوجل ناقص أو غير صحيح، الشكل الصحيح: AW-123456789/AbC_DeF', 'error');
      return;
    }

    const expiresDate = new Date(expiresInput);
    if (Number.isNaN(expiresDate.getTime())) {
      showToast('تاريخ الانتهاء غير صحيح', 'error');
      return;
    }

    const expires_at = expiresDate.toISOString();

    const { error: err } = await adminUpdatePage(id, {
      theme,
      title,
      phone,
      description,
      gtag_label,
      working_hours,
      is_active,
      is_trial,
      whatsapp,
      instagram,
      snapchat,
      tiktok,
      expires_at,
    });

    if (err) {
      console.error(err);
      showToast('حدث خطأ أثناء حفظ بيانات العميل', 'error');
      return;
    }

    showToast('تم حفظ تعديلات العميل بنجاح', 'success');
    closeEditModal();
    await renderAdmin(container);
  });

  let currentFilter = 'all';
  let searchTerm = '';

  const applyFilters = () => {
    let filtered = pagesWithStatus;

    if (currentFilter === 'active') {
      filtered = filtered.filter((p) => !p.isExpired && p.is_active !== false);
    }

    if (currentFilter === 'expired') {
      filtered = filtered.filter((p) => p.isExpired);
    }

    if (currentFilter === 'suspended') {
      filtered = filtered.filter((p) => p.is_active === false);
    }

    if (currentFilter === 'expiring') {
      filtered = filtered.filter((p) => p.isExpiringSoon && p.is_active !== false);
    }

    if (currentFilter === 'trial') {
      filtered = filtered.filter((p) => p.is_trial === true && !p.isExpired);
    }

    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          (p.title || '').toLowerCase().includes(q) ||
          (p.company_name || '').toLowerCase().includes(q) ||
          (p.phone || '').includes(q) ||
          (p.slug || '').toLowerCase().includes(q),
      );
    }

    renderCards(filtered);
  };

  container.querySelector('#searchInput').addEventListener('input', (e) => {
    searchTerm = e.target.value.trim();
    applyFilters();
  });

  container.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.filter-btn').forEach((b) => {
        b.className = 'filter-btn px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-slate-300 hover:bg-slate-800';
      });

      btn.className = 'filter-btn px-4 py-2 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950';
      currentFilter = btn.dataset.filter;
      applyFilters();
    });
  });

  renderCards(pagesWithStatus);
}