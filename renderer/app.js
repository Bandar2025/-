
// استدعاء مكتبة PouchDB
const PouchDB = require('pouchdb-browser');

// 1. تهيئة قاعدة البيانات المحلية
const db = new PouchDB('coffee_offline_db');

// متغيرات الحالة (State) للنظام
let saleLines = [];
let purchaseLines = [];
let currentUser = null; // المستخدم الحالي

// ==========================================
// Initialization & Utils
// ==========================================

// عند تحميل الصفحة
document.addEventListener('DOMContentLoaded', async () => {
    // 1. ربط الأحداث أولاً لضمان استجابة الواجهة
    setupEventListeners();

    // 2. تهيئة البيانات
    try {
        await initDB();
        await checkAndCreateDefaultUser(); // سيتم ضمان وجود الأدمن هنا
        await initAccounting();
        
        // تعريض الدوال للنطاق العام (Window)
        window.addItemToPurchase = addItemToPurchase;
        window.loadProducts = loadProducts;
        window.loadRecentExpenses = loadRecentExpenses;
        window.loadCustomers = loadCustomers;
        window.loadUsers = loadUsers;
        window.deleteDoc = deleteDoc;
        window.generateDailyReport = generateDailyReport;
        window.generateInventoryReport = generateInventoryReport;
        window.logout = logout;

    } catch (err) {
        console.error('Initialization error:', err);
    }
});

function setupEventListeners() {
    // تسجيل الدخول
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        // إزالة أي مستمعين سابقين لتجنب التكرار (احتياطاً)
        const newLoginForm = loginForm.cloneNode(true);
        loginForm.parentNode.replaceChild(newLoginForm, loginForm);
        newLoginForm.addEventListener('submit', handleLogin);
    }

    // 1. نموذج إضافة منتج
    const addProductForm = document.getElementById('add-product-form');
    if (addProductForm) {
        addProductForm.addEventListener('submit', createProductFromUI);
    }

    // 2. اختيار منتج في نقطة البيع
    const posSelect = document.getElementById('pos-product-select');
    if (posSelect) {
        posSelect.addEventListener('change', (e) => {
            const productId = e.target.value;
            if (productId) {
                addLineToCurrentSale(productId, 1);
                e.target.value = ''; // إعادة تعيين
            }
        });
    }

    // 3. زر حفظ الفاتورة
    const saveSaleBtn = document.querySelector('#sales .btn-primary');
    if (saveSaleBtn) {
        saveSaleBtn.addEventListener('click', saveCurrentSale);
    }

    // 4. زر حفظ المشتريات
    const savePurchaseBtn = document.getElementById('save-purchase-btn');
    if (savePurchaseBtn) {
        savePurchaseBtn.addEventListener('click', saveCurrentPurchase);
    }

    // 5. نموذج إضافة مصروف
    const addExpenseForm = document.getElementById('add-expense-form');
    if (addExpenseForm) {
        addExpenseForm.addEventListener('submit', createExpenseFromUI);
    }

    // 6. نموذج إضافة عميل
    const addCustomerForm = document.getElementById('add-customer-form');
    if (addCustomerForm) {
        addCustomerForm.addEventListener('submit', createCustomerFromUI);
    }

    // 7. إعدادات المزامنة
    const saveUrlBtn = document.getElementById('save-url-btn');
    if (saveUrlBtn) {
        saveUrlBtn.addEventListener('click', () => {
            const url = document.getElementById('remote-url-input').value;
            Config.setRemoteUrl(url);
            alert('تم حفظ الرابط');
        });
    }

    const syncNowBtn = document.getElementById('sync-now-btn');
    if (syncNowBtn) {
        syncNowBtn.addEventListener('click', syncNow);
    }

    // 8. نموذج إضافة مستخدم جديد
    const createUserForm = document.getElementById('create-user-form');
    if (createUserForm) {
        createUserForm.addEventListener('submit', createUserFromUI);
    }
}

// دالة توليد UUID
function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// دالة للحصول على الوقت الحالي ISO
function now() {
    return new Date().toISOString();
}

// تنسيق التاريخ للعرض
function formatDate(isoString) {
    if (!isoString) return '';
    return new Date(isoString).toLocaleString('ar-SA');
}

// تهيئة الفهارس (اختياري مع البحث اليدوي ولكن مفيد للمستقبل)
async function initDB() {
    try {
        if (db.createIndex) {
            await db.createIndex({ index: { fields: ['type'] } });
            // db.createIndex للحقول الأخرى يحتاج pouchdb-find، لذا نتجاوزه إذا لم يكن مدعوماً
        }
    } catch (err) {
        console.warn('Index creation warning:', err);
    }
}

// دالة مساعدة للبحث اليدوي بدلاً من plugin (pouchdb-find)
// لتجنب أخطاء db.find is not a function
async function findDocs(criteria) {
    try {
        const result = await db.allDocs({ include_docs: true });
        return result.rows.map(r => r.doc).filter(doc => {
            // تحقق من جميع الشروط في criteria
            for (let key in criteria) {
                if (doc[key] !== criteria[key]) return false;
            }
            return true;
        });
    } catch (err) {
        console.error('findDocs error:', err);
        return [];
    }
}

// ==========================================
// Accounting System Logic (Double Entry)
// ==========================================

const ACCOUNT_CODES = {
    CASH: '1100', // الصندوق
    BANK: '1101', // البنك
    INVENTORY: '1200', // المخزون
    AR: '1300', // العملاء (مدينون)
    AP: '2100', // الموردين (دائنون)
    CAPITAL: '3100', // رأس المال
    SALES: '4100', // المبيعات
    COGS: '5100', // تكلفة البضاعة المباعة
    EXPENSES_GEN: '5200' // مصروفات عامة
};

async function initAccounting() {
    try {
        const defaultAccounts = [
            { code: ACCOUNT_CODES.CASH, name: 'الصندوق', type: 'asset' },
            { code: ACCOUNT_CODES.BANK, name: 'البنك', type: 'asset' },
            { code: ACCOUNT_CODES.INVENTORY, name: 'المخزون', type: 'asset' },
            { code: ACCOUNT_CODES.AR, name: 'العملاء (ذمم مدينة)', type: 'asset' },
            { code: ACCOUNT_CODES.AP, name: 'الموردين (ذمم دائنة)', type: 'liability' },
            { code: ACCOUNT_CODES.CAPITAL, name: 'رأس المال', type: 'equity' },
            { code: ACCOUNT_CODES.SALES, name: 'المبيعات', type: 'revenue' },
            { code: ACCOUNT_CODES.COGS, name: 'تكلفة البضاعة المباعة', type: 'expense' },
            { code: ACCOUNT_CODES.EXPENSES_GEN, name: 'مصروفات عامة', type: 'expense' }
        ];

        for (const acc of defaultAccounts) {
            await createAccountIfNotExists(acc);
        }
        console.log('Accounting chart initialized.');
    } catch (err) {
        console.error('Accounting init error:', err);
    }
}

async function createAccountIfNotExists(accData) {
    // استخدام findDocs البديلة
    const docs = await findDocs({ type: 'account', code: accData.code });
    
    if (docs.length === 0) {
        await db.put({
            _id: `account_${uuid()}`,
            type: 'account',
            code: accData.code,
            name: accData.name,
            account_type: accData.type,
            is_active: true,
            created_at: now()
        });
    }
}

async function getAccountByCode(code) {
    const docs = await findDocs({ type: 'account', code: code });
    return docs[0] || null;
}

async function getOrCreateExpenseAccount(categoryName) {
    const docs = await findDocs({ type: 'account', name: categoryName });
    
    if (docs.length > 0) return docs[0];

    const randomCode = '5' + Math.floor(Math.random() * 900 + 100); 
    const newAccount = {
        _id: `account_${uuid()}`,
        type: 'account',
        code: randomCode,
        name: categoryName,
        account_type: 'expense',
        is_active: true,
        created_at: now()
    };
    await db.put(newAccount);
    return newAccount;
}

async function createJournalEntry(description, lines, relatedDocId = null) {
    const totalDebit = lines.reduce((sum, l) => sum + (l.debit || 0), 0);
    const totalCredit = lines.reduce((sum, l) => sum + (l.credit || 0), 0);

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
        console.warn(`Journal Entry Unbalanced: Debit ${totalDebit} != Credit ${totalCredit}`);
    }

    const doc = {
        _id: `je_${uuid()}`,
        type: 'journal_entry',
        datetime: now(),
        description: description,
        lines: lines,
        related_doc_id: relatedDocId,
        total_amount: totalDebit,
        created_at: now()
    };

    return await db.put(doc);
}

// ==========================================
// User Authentication Logic
// ==========================================

async function checkAndCreateDefaultUser() {
    try {
        const result = await db.allDocs({ include_docs: true });
        const users = result.rows.map(r => r.doc).filter(d => d.type === 'user');
        
        const adminUser = users.find(u => u.username === 'admin');

        if (!adminUser) {
            console.log('Creating default admin user...');
            await db.put({
                _id: `user_${uuid()}`,
                type: 'user',
                username: 'admin',
                password_hash: '123456',
                role: 'admin',
                is_active: true,
                created_at: now()
            });
            console.log('Default admin created: admin / 123456');
        } else {
            // ضمان أن كلمة المرور هي 123456 (لأغراض التطوير إذا تعطل الدخول)
            if (adminUser.password_hash !== '123456') {
                console.log('Resetting admin password to 123456...');
                adminUser.password_hash = '123456';
                await db.put(adminUser);
            } else {
                console.log('Admin user exists and password is correct.');
            }
        }
    } catch (err) {
        console.error('Error checking users:', err);
    }
}

async function handleLogin(e) {
    e.preventDefault();
    console.log('Login attempt...');
    
    const usernameInput = document.getElementById('login-username').value.trim(); // Trim spaces
    const passwordInput = document.getElementById('login-password').value;
    const errorMsg = document.getElementById('login-error');

    if (errorMsg) errorMsg.style.display = 'none';

    try {
        const result = await db.allDocs({ include_docs: true });
        const users = result.rows.map(r => r.doc).filter(d => d.type === 'user');
        
        console.log('Available users in DB:', users.map(u => u.username)); // Debug log

        const user = users.find(u => u.username === usernameInput && u.password_hash === passwordInput && u.is_active);

        if (user) {
            currentUser = user;
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('app-content').style.display = 'block';
            document.getElementById('user-display').textContent = `مرحباً، ${user.username} (${user.role === 'admin' ? 'مدير' : 'كاشير'})`;
            
            // تحميل البيانات
            loadProducts();
            fillProductsSelectForSales();
            fillProductsSelectForPurchases();
            loadRecentExpenses();
            loadCustomers();
            
            // تطبيق الصلاحيات
            applyPermissions();
            
            if (currentUser.role === 'admin') {
                loadUsers();
            }
        } else {
            if (errorMsg) {
                errorMsg.textContent = 'اسم المستخدم أو كلمة المرور غير صحيحة';
                errorMsg.style.display = 'block';
            }
        }
    } catch (err) {
        console.error('Login error:', err);
        if (errorMsg) {
            errorMsg.textContent = 'حدث خطأ في النظام: ' + err.message;
            errorMsg.style.display = 'block';
        }
    }
}

function logout() {
    currentUser = null;
    document.getElementById('app-content').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('login-form').reset();
}

function applyPermissions() {
    const adminBtns = document.querySelectorAll('.admin-only');
    adminBtns.forEach(btn => {
        if (currentUser.role !== 'admin') {
            btn.style.display = 'none';
        } else {
            btn.style.display = 'inline-block';
        }
    });
}

// ==========================================
// User Management Logic
// ==========================================

async function createUserFromUI(e) {
    e.preventDefault();
    const username = document.getElementById('new-username').value;
    const password = document.getElementById('new-password').value;
    const role = document.getElementById('new-role').value;

    if (!username || !password) {
        alert('يرجى تعبئة جميع الحقول');
        return;
    }

    try {
        // التحقق من تكرار الاسم باستخدام findDocs
        const existingUsers = await findDocs({ type: 'user', username: username });

        if (existingUsers.length > 0) {
            alert('اسم المستخدم موجود بالفعل، اختر اسماً آخر.');
            return;
        }

        const doc = {
            _id: `user_${uuid()}`,
            type: 'user',
            username: username,
            password_hash: password,
            role: role,
            is_active: true,
            created_at: now()
        };

        await db.put(doc);
        alert('تمت إضافة المستخدم بنجاح');
        document.getElementById('create-user-form').reset();
        loadUsers();
    } catch (err) {
        console.error(err);
        alert('حدث خطأ أثناء إضافة المستخدم');
    }
}

async function loadUsers() {
    const tbody = document.getElementById('users-list-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4">جاري التحميل...</td></tr>';

    try {
        const result = await db.allDocs({ include_docs: true });
        const users = result.rows
            .map(r => r.doc)
            .filter(d => d.type === 'user');

        tbody.innerHTML = '';
        users.forEach(u => {
            const tr = document.createElement('tr');
            
            let deleteBtnHtml = '';
            if (currentUser && currentUser.username === u.username) {
                deleteBtnHtml = '<span style="color:gray;">الحساب الحالي</span>';
            } else {
                deleteBtnHtml = `<button class="btn" style="background:red; padding:5px 10px; font-size:0.8rem;" onclick="deleteDoc('${u._id}', loadUsers)">حذف</button>`;
            }

            tr.innerHTML = `
                <td>${u.username}</td>
                <td>${u.role === 'admin' ? 'مدير' : 'كاشير'}</td>
                <td>${formatDate(u.created_at)}</td>
                <td>${deleteBtnHtml}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="4">خطأ في التحميل</td></tr>';
    }
}

// ==========================================
// Sync Logic
// ==========================================

async function syncNow() {
    const remoteUrl = Config.getRemoteUrl();
    const statusDiv = document.getElementById('sync-status');
    
    if (!remoteUrl) {
        statusDiv.textContent = 'يرجى إدخال رابط الخادم وحفظه أولاً';
        statusDiv.style.color = 'red';
        return;
    }

    statusDiv.textContent = 'جاري الاتصال والمزامنة...';
    statusDiv.style.color = 'blue';

    try {
        const remoteDB = new PouchDB(remoteUrl);
        await db.sync(remoteDB);
        
        statusDiv.textContent = 'تمت المزامنة بنجاح ✅';
        statusDiv.style.color = 'green';
        
        loadProducts();
        fillProductsSelectForSales();
        loadRecentExpenses();
        loadCustomers();
        if (currentUser && currentUser.role === 'admin') loadUsers();
        
    } catch (err) {
        console.error('Sync Error:', err);
        statusDiv.textContent = 'فشل المزامنة ❌: ' + (err.message || 'تأكد من تشغيل الخادم');
        statusDiv.style.color = 'red';
    }
}

// ==========================================
// Stock Logic
// ==========================================

async function createStockMovement(data) {
    const doc = {
        _id: `stock_${uuid()}`,
        type: 'stock_movement',
        product_id: data.product_id,
        qty_change: Number(data.qty_change),
        reason: data.reason, 
        related_doc_id: data.related_doc_id || null,
        datetime: now(),
        created_at: now()
    };
    return await db.put(doc);
}

async function getCurrentStock(productId) {
    try {
        const result = await db.allDocs({ include_docs: true });
        const movements = result.rows
            .map(r => r.doc)
            .filter(d => d.type === 'stock_movement' && d.product_id === productId);

        const total = movements.reduce((sum, mov) => sum + (Number(mov.qty_change) || 0), 0);
        return total;
    } catch (e) {
        console.error('Stock calc error', e);
        return 0;
    }
}

// ==========================================
// Products Management
// ==========================================

async function createProductFromUI(e) {
    e.preventDefault();
    const name = document.getElementById('p-name').value;
    const price = document.getElementById('p-price').value;
    const unit = document.getElementById('p-unit').value;
    const category = document.getElementById('p-category').value;

    if (!name || !price) {
        alert('يرجى إدخال الاسم والسعر');
        return;
    }

    try {
        await createProduct({ name, sale_price: price, unit, category });
        alert('تمت إضافة المنتج بنجاح');
        document.getElementById('add-product-form').reset();
        loadProducts();
        fillProductsSelectForSales();
        fillProductsSelectForPurchases();
    } catch (err) {
        console.error(err);
        alert('حدث خطأ أثناء الحفظ');
    }
}

async function createProduct(data) {
    const doc = {
        _id: `product_${uuid()}`,
        type: 'product',
        name: data.name,
        sku: uuid().substring(0, 8),
        unit: data.unit || 'حبة',
        cost_price: 0,
        sale_price: Number(data.sale_price),
        category: data.category || 'عام',
        created_at: now(),
        updated_at: now()
    };
    return await db.put(doc);
}

async function loadProducts() {
    const tbody = document.getElementById('products-list-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6">جاري التحميل...</td></tr>';

    try {
        const result = await db.allDocs({ include_docs: true });
        const products = result.rows
            .map(r => r.doc)
            .filter(d => d.type === 'product');

        tbody.innerHTML = '';
        
        for (const p of products) {
            const stock = await getCurrentStock(p._id);
            const tr = document.createElement('tr');
            
            let deleteBtnHtml = '';
            if (currentUser && currentUser.role === 'admin') {
                deleteBtnHtml = `<button class="btn" style="background:red; color:white; padding:5px 10px;" onclick="deleteDoc('${p._id}', loadProducts)">حذف</button>`;
            } else {
                deleteBtnHtml = '<span style="color:#999">غير مصرح</span>';
            }

            tr.innerHTML = `
                <td>${p.name}</td>
                <td>${p.category}</td>
                <td>${p.sale_price}</td>
                <td>${p.unit}</td>
                <td style="direction:ltr; text-align:right;">${stock}</td>
                <td>${deleteBtnHtml}</td>
            `;
            tbody.appendChild(tr);
        }
    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="6">خطأ في التحميل</td></tr>';
    }
}

async function fillProductsSelectForSales() {
    const select = document.getElementById('pos-product-select');
    if (!select) return;
    
    try {
        const result = await db.allDocs({ include_docs: true });
        const products = result.rows.map(r => r.doc).filter(d => d.type === 'product');

        select.innerHTML = '<option value="">-- اختر منتجاً للإضافة --</option>';
        products.forEach(p => {
            const option = document.createElement('option');
            option.value = p._id;
            option.textContent = `${p.name} (${p.sale_price} ريال)`;
            select.appendChild(option);
        });
    } catch (err) { console.error(err); }
}

async function fillProductsSelectForPurchases() {
    const select = document.getElementById('purchase-product-select');
    if (!select) return;
    
    try {
        const result = await db.allDocs({ include_docs: true });
        const products = result.rows.map(r => r.doc).filter(d => d.type === 'product');

        select.innerHTML = '<option value="">-- اختر منتج --</option>';
        products.forEach(p => {
            const option = document.createElement('option');
            option.value = p._id;
            option.textContent = p.name;
            select.appendChild(option);
        });
    } catch (err) { console.error(err); }
}

// ==========================================
// Sales (POS) Logic
// ==========================================

async function addLineToCurrentSale(productId, qty) {
    try {
        const product = await db.get(productId);
        
        const existingLine = saleLines.find(l => l.product_id === productId);
        if (existingLine) {
            existingLine.qty += qty;
            existingLine.line_total = existingLine.qty * existingLine.price;
        } else {
            saleLines.push({
                product_id: product._id,
                product_name: product.name,
                qty: qty,
                price: product.sale_price,
                cost_price: product.cost_price || 0,
                line_total: qty * product.sale_price
            });
        }
        renderSaleLines();
    } catch (err) {
        console.error('Product not found', err);
    }
}

function renderSaleLines() {
    const tbody = document.getElementById('invoice-items');
    const totalEl = document.getElementById('total-price');
    tbody.innerHTML = '';
    
    let total = 0;
    saleLines.forEach((line, index) => {
        total += line.line_total;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${line.product_name}</td>
            <td><input type="number" value="${line.qty}" min="1" style="width:60px" onchange="updateSaleQty(${index}, this.value)"></td>
            <td>${line.price}</td>
            <td><button style="color:red" onclick="removeSaleLine(${index})">X</button></td>
        `;
        tbody.appendChild(tr);
    });
    
    totalEl.textContent = total.toFixed(2);
}

window.updateSaleQty = function(index, newQty) {
    if (newQty < 1) newQty = 1;
    saleLines[index].qty = Number(newQty);
    saleLines[index].line_total = saleLines[index].qty * saleLines[index].price;
    renderSaleLines();
};

window.removeSaleLine = function(index) {
    saleLines.splice(index, 1);
    renderSaleLines();
};

async function saveCurrentSale() {
    if (saleLines.length === 0) {
        alert('الفاتورة فارغة!');
        return;
    }

    const total = saleLines.reduce((acc, l) => acc + l.line_total, 0);
    const totalCOGS = saleLines.reduce((acc, l) => acc + (l.qty * (l.cost_price || 0)), 0);
    
    try {
        const saleDoc = {
            _id: `sale_${uuid()}`,
            type: 'sale',
            datetime: now(),
            total: total,
            lines: saleLines,
            created_at: now(),
            updated_at: now()
        };
        const response = await db.put(saleDoc);
        
        for (const line of saleLines) {
            await createStockMovement({
                product_id: line.product_id,
                qty_change: -Math.abs(line.qty),
                reason: 'sale',
                related_doc_id: response.id
            });
        }

        const cashAcc = await getAccountByCode(ACCOUNT_CODES.CASH);
        const salesAcc = await getAccountByCode(ACCOUNT_CODES.SALES);

        if (cashAcc && salesAcc) {
            await createJournalEntry(`فاتورة بيع رقم ${response.id}`, [
                { account_id: cashAcc._id, debit: total, credit: 0 },
                { account_id: salesAcc._id, debit: 0, credit: total }
            ], response.id);
        }

        if (totalCOGS > 0) {
            const cogsAcc = await getAccountByCode(ACCOUNT_CODES.COGS);
            const invAcc = await getAccountByCode(ACCOUNT_CODES.INVENTORY);

            if (cogsAcc && invAcc) {
                await createJournalEntry(`تكلفة مبيعات فاتورة ${response.id}`, [
                    { account_id: cogsAcc._id, debit: totalCOGS, credit: 0 },
                    { account_id: invAcc._id, debit: 0, credit: totalCOGS }
                ], response.id);
            }
        }

        alert('تم حفظ الفاتورة وإنشاء القيود المحاسبية!');
        saleLines = [];
        renderSaleLines();
        loadProducts();
    } catch (err) {
        console.error(err);
        alert('حدث خطأ أثناء حفظ الفاتورة');
    }
}

// ==========================================
// Purchases Logic
// ==========================================

async function addItemToPurchase() {
    const select = document.getElementById('purchase-product-select');
    const qtyInput = document.getElementById('purchase-qty');
    const costInput = document.getElementById('purchase-cost');

    const productId = select.value;
    const qty = Number(qtyInput.value);
    const cost = Number(costInput.value);

    if (!productId || qty <= 0) {
        alert('تأكد من اختيار المنتج والكمية');
        return;
    }

    try {
        const product = await db.get(productId);
        
        purchaseLines.push({
            product_id: productId,
            product_name: product.name,
            qty: qty,
            cost_price: cost,
            line_total: qty * cost
        });

        select.value = '';
        qtyInput.value = 1;
        costInput.value = '';

        renderPurchaseLines();
    } catch (err) {
        console.error(err);
    }
}

function renderPurchaseLines() {
    const tbody = document.getElementById('purchase-items');
    const totalEl = document.getElementById('purchase-total-price');
    tbody.innerHTML = '';

    let total = 0;
    purchaseLines.forEach((line, index) => {
        total += line.line_total;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${line.product_name}</td>
            <td>${line.qty}</td>
            <td>${line.cost_price}</td>
            <td>${line.line_total.toFixed(2)}</td>
            <td><button style="color:red" onclick="removePurchaseLine(${index})">X</button></td>
        `;
        tbody.appendChild(tr);
    });

    totalEl.textContent = total.toFixed(2);
}

window.removePurchaseLine = function(index) {
    purchaseLines.splice(index, 1);
    renderPurchaseLines();
};

async function saveCurrentPurchase() {
    if (purchaseLines.length === 0) {
        alert('قائمة المشتريات فارغة');
        return;
    }

    const supplierName = document.getElementById('purchase-supplier').value;
    const total = purchaseLines.reduce((sum, l) => sum + l.line_total, 0);

    try {
        const purchaseDoc = {
            _id: `purchase_${uuid()}`,
            type: 'purchase',
            supplier_id: supplierName || 'غير محدد',
            supplier_name: supplierName,
            total: total,
            lines: purchaseLines,
            datetime: now(),
            created_at: now()
        };
        const response = await db.put(purchaseDoc);

        for (const line of purchaseLines) {
            await createStockMovement({
                product_id: line.product_id,
                qty_change: Math.abs(line.qty),
                reason: 'purchase',
                related_doc_id: response.id
            });
            
            try {
                const prod = await db.get(line.product_id);
                prod.cost_price = line.cost_price;
                await db.put(prod);
            } catch(e) {}
        }

        const invAcc = await getAccountByCode(ACCOUNT_CODES.INVENTORY);
        const creditAcc = supplierName 
            ? await getAccountByCode(ACCOUNT_CODES.AP) 
            : await getAccountByCode(ACCOUNT_CODES.CASH);

        if (invAcc && creditAcc) {
            await createJournalEntry(`فاتورة شراء من ${supplierName || 'نقدي'}`, [
                { account_id: invAcc._id, debit: total, credit: 0 },
                { account_id: creditAcc._id, debit: 0, credit: total }
            ], response.id);
        }

        alert('تم حفظ عملية الشراء، تحديث المخزون، والترحيل المحاسبي');
        purchaseLines = [];
        renderPurchaseLines();
        document.getElementById('purchase-supplier').value = '';
        loadProducts();
    } catch (err) {
        console.error(err);
        alert('فشل الحفظ');
    }
}

// ==========================================
// Expenses Logic
// ==========================================

async function createExpenseFromUI(e) {
    e.preventDefault();
    const category = document.getElementById('exp-category').value;
    const amount = document.getElementById('exp-amount').value;
    const note = document.getElementById('exp-note').value;

    if (!category || !amount) {
        alert('الرجاء إدخال الفئة والمبلغ');
        return;
    }

    try {
        await createExpense({ category, amount, note });
        alert('تم حفظ المصروف وترحيله محاسبياً');
        document.getElementById('add-expense-form').reset();
        loadRecentExpenses();
    } catch (err) {
        console.error(err);
        alert('حدث خطأ');
    }
}

async function createExpense(data) {
    const amountVal = Number(data.amount);
    
    const doc = {
        _id: `expense_${uuid()}`,
        type: 'expense',
        category: data.category,
        amount: amountVal,
        note: data.note || '',
        datetime: now(),
        created_at: now()
    };
    const response = await db.put(doc);

    const expenseAcc = await getOrCreateExpenseAccount(data.category);
    const cashAcc = await getAccountByCode(ACCOUNT_CODES.CASH);

    if (expenseAcc && cashAcc) {
        await createJournalEntry(`مصروف: ${data.category}`, [
            { account_id: expenseAcc._id, debit: amountVal, credit: 0 },
            { account_id: cashAcc._id, debit: 0, credit: amountVal }
        ], response.id);
    }

    return response;
}

async function loadRecentExpenses() {
    const tbody = document.getElementById('expenses-list-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5">جاري التحميل...</td></tr>';

    try {
        const result = await db.allDocs({ include_docs: true });
        const expenses = result.rows
            .map(r => r.doc)
            .filter(d => d.type === 'expense')
            .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))
            .slice(0, 20);

        tbody.innerHTML = '';
        expenses.forEach(exp => {
            const tr = document.createElement('tr');
            
            let deleteBtnHtml = '';
            if (currentUser && currentUser.role === 'admin') {
                deleteBtnHtml = `<button class="btn" style="background:red; padding:5px;" onclick="deleteDoc('${exp._id}', loadRecentExpenses)">حذف</button>`;
            } else {
                deleteBtnHtml = '<span style="color:#999">غير مصرح</span>';
            }

            tr.innerHTML = `
                <td>${formatDate(exp.datetime)}</td>
                <td>${exp.category}</td>
                <td>${exp.amount.toFixed(2)}</td>
                <td>${exp.note}</td>
                <td>${deleteBtnHtml}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error(err);
    }
}

// ==========================================
// Customers Logic
// ==========================================

async function createCustomerFromUI(e) {
    e.preventDefault();
    const name = document.getElementById('cust-name').value;
    const phone = document.getElementById('cust-phone').value;
    const balance = document.getElementById('cust-balance').value;

    if (!name) {
        alert('اسم العميل مطلوب');
        return;
    }

    try {
        await createCustomer({ name, phone, opening_balance: balance });
        alert('تمت إضافة العميل');
        document.getElementById('add-customer-form').reset();
        loadCustomers();
    } catch (err) {
        console.error(err);
        alert('حدث خطأ');
    }
}

async function createCustomer(data) {
    const bal = Number(data.opening_balance) || 0;
    const doc = {
        _id: `customer_${uuid()}`,
        type: 'customer',
        name: data.name,
        phone: data.phone || '',
        opening_balance: bal,
        current_balance: bal,
        created_at: now(),
        updated_at: now()
    };
    return await db.put(doc);
}

async function loadCustomers() {
    const tbody = document.getElementById('customers-list-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4">جاري التحميل...</td></tr>';

    try {
        const result = await db.allDocs({ include_docs: true });
        const customers = result.rows
            .map(r => r.doc)
            .filter(d => d.type === 'customer')
            .sort((a, b) => a.name.localeCompare(b.name, 'ar'));

        tbody.innerHTML = '';
        customers.forEach(cust => {
            const tr = document.createElement('tr');
            
            let deleteBtnHtml = '';
            if (currentUser && currentUser.role === 'admin') {
                deleteBtnHtml = `<button class="btn" style="background:red; padding:5px;" onclick="deleteDoc('${cust._id}', loadCustomers)">حذف</button>`;
            } else {
                deleteBtnHtml = '<span style="color:#999">غير مصرح</span>';
            }

            tr.innerHTML = `
                <td>${cust.name}</td>
                <td>${cust.phone}</td>
                <td>${cust.current_balance.toFixed(2)}</td>
                <td>${deleteBtnHtml}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error(err);
    }
}

// ==========================================
// Reports Logic
// ==========================================

async function generateDailyReport() {
    const dateInput = document.getElementById('report-date-input');
    const selectedDate = dateInput.value;

    if (!selectedDate) {
        alert('الرجاء اختيار تاريخ');
        return;
    }

    try {
        const result = await db.allDocs({ include_docs: true });
        const docs = result.rows.map(r => r.doc);

        const daySales = docs.filter(d => d.type === 'sale' && isSameDay(d.datetime, selectedDate));
        const dayExpenses = docs.filter(d => d.type === 'expense' && isSameDay(d.datetime, selectedDate));

        const salesTotal = daySales.reduce((acc, sale) => acc + (Number(sale.total) || 0), 0);
        const expensesTotal = dayExpenses.reduce((acc, exp) => acc + (Number(exp.amount) || 0), 0);
        const netTotal = salesTotal - expensesTotal;

        document.getElementById('report-sales-total').textContent = salesTotal.toFixed(2);
        document.getElementById('report-sales-count').textContent = `عدد الفواتير: ${daySales.length}`;
        
        document.getElementById('report-expenses-total').textContent = expensesTotal.toFixed(2);
        document.getElementById('report-expenses-count').textContent = `عدد المصروفات: ${dayExpenses.length}`;

        document.getElementById('report-net-total').textContent = netTotal.toFixed(2);

        const salesBody = document.getElementById('report-sales-body');
        salesBody.innerHTML = '';
        daySales.forEach(sale => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${sale._id.substr(0, 10)}...</td>
                <td>${formatDate(sale.datetime)}</td>
                <td>${Number(sale.total).toFixed(2)}</td>
            `;
            salesBody.appendChild(tr);
        });

        const expensesBody = document.getElementById('report-expenses-body');
        expensesBody.innerHTML = '';
        dayExpenses.forEach(exp => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDate(exp.datetime)}</td>
                <td>${exp.category}</td>
                <td>${Number(exp.amount).toFixed(2)}</td>
            `;
            expensesBody.appendChild(tr);
        });

    } catch (err) {
        console.error(err);
        alert('حدث خطأ أثناء جلب التقرير');
    }
}

function isSameDay(isoString, yyyyMmDd) {
    if (!isoString) return false;
    const date = new Date(isoString);
    const localIso = date.toLocaleDateString('en-CA'); 
    return localIso === yyyyMmDd;
}

async function generateInventoryReport() {
    const tbody = document.getElementById('report-inventory-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="3">جاري الحساب...</td></tr>';

    try {
        const result = await db.allDocs({ include_docs: true });
        const docs = result.rows.map(r => r.doc);

        const products = docs.filter(d => d.type === 'product');
        const movements = docs.filter(d => d.type === 'stock_movement');

        const stockMap = {};
        
        movements.forEach(m => {
            const pid = m.product_id;
            const change = Number(m.qty_change) || 0;
            if (!stockMap[pid]) stockMap[pid] = 0;
            stockMap[pid] += change;
        });

        tbody.innerHTML = '';
        products.forEach(p => {
            const qty = stockMap[p._id] || 0;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${p.name}</td>
                <td>${p.unit}</td>
                <td style="direction:ltr; text-align:right; font-weight:bold;">${qty}</td>
            `;
            tbody.appendChild(tr);
        });

    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="3">خطأ في التقرير</td></tr>';
    }
}

// ==========================================
// General Helpers
// ==========================================

async function deleteDoc(id, callback) {
    if (currentUser.role !== 'admin') {
        alert('غير مصرح لك بالحذف');
        return;
    }
    if (!confirm('هل أنت متأكد من الحذف؟')) return;
    try {
        const doc = await db.get(id);
        await db.remove(doc);
        if (callback && typeof callback === 'function') callback();
    } catch (err) {
        console.error(err);
        alert('خطأ في الحذف');
    }
}
