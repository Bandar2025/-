// كائن للتعامل مع الإعدادات المخزنة محلياً
const Config = {
    // مفتاح التخزين في LocalStorage
    STORAGE_KEY: 'coffee_app_remote_url',

    // جلب الرابط المخزن
    getRemoteUrl: function() {
        return localStorage.getItem(this.STORAGE_KEY) || '';
    },

    // حفظ الرابط الجديد
    setRemoteUrl: function(url) {
        if (!url) return;
        localStorage.setItem(this.STORAGE_KEY, url);
        console.log('تم حفظ رابط قاعدة البيانات:', url);
    },

    // مسح الإعدادات (إذا لزم الأمر)
    clearConfig: function() {
        localStorage.removeItem(this.STORAGE_KEY);
    }
};

// عند تحميل الصفحة، املأ حقل الإدخال إذا كان هناك قيمة محفوظة
document.addEventListener('DOMContentLoaded', () => {
    const remoteInput = document.getElementById('remote-url-input');
    if (remoteInput) {
        remoteInput.value = Config.getRemoteUrl();
    }
});