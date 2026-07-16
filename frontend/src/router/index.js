import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import ShopView from '../views/ShopView.vue';
import ProductDetailView from '../views/ProductDetailView.vue';
import CheckoutView from '../views/CheckoutView.vue';
import MyOrdersView from '../views/MyOrdersView.vue';
import ProductsAdminView from '../views/admin/ProductsAdminView.vue';
import InventoryAdminView from '../views/admin/InventoryAdminView.vue';
import StockTransfersView from '../views/admin/StockTransfersView.vue';
import PurchaseOrdersView from '../views/admin/PurchaseOrdersView.vue';
import RmasAdminView from '../views/admin/RmasAdminView.vue';
import OrdersAdminView from '../views/admin/OrdersAdminView.vue';
import ReportsView from '../views/admin/ReportsView.vue';
import PromotionsView from '../views/admin/PromotionsView.vue';
import CategoriesView from '../views/CategoriesView.vue';
import CustomersView from '../views/CustomersView.vue';
import UsersView from '../views/UsersView.vue';
import LoginView from '../views/LoginView.vue';
import RegisterView from '../views/RegisterView.vue';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/login',    name: 'login',    component: LoginView,    meta: { public: true } },
    { path: '/register', name: 'register', component: RegisterView, meta: { public: true } },
    {
      path: '/',
      name: 'home',
      component: HomeView,
      children: [
        // Storefront — open to anonymous guests (guest cart + guest checkout)
        { path: 'shop',                 name: 'shop',         component: ShopView,          meta: { guestOk: true } },
        { path: 'shop/:product_no',     name: 'product',      component: ProductDetailView, meta: { guestOk: true } },
        { path: 'checkout',             name: 'checkout',     component: CheckoutView,      meta: { guestOk: true } },
        { path: 'orders',               name: 'orders',       component: MyOrdersView },

        // Staff — gated by permission codes from the JWT
        { path: 'admin/products',   name: 'admin-products',   component: ProductsAdminView,
          meta: { requiresPerm: ['catalog:write'] } },
        { path: 'admin/inventory',  name: 'admin-inventory',  component: InventoryAdminView,
          meta: { requiresPerm: ['inventory:read'] } },
        { path: 'admin/transfers',  name: 'admin-transfers',  component: StockTransfersView,
          meta: { requiresPerm: ['inventory:transfer'] } },
        { path: 'admin/purchasing', name: 'admin-purchasing', component: PurchaseOrdersView,
          meta: { requiresPerm: ['purchasing:manage', 'inventory:receive'] } },
        { path: 'admin/rmas',       name: 'admin-rmas',       component: RmasAdminView,
          meta: { requiresPerm: ['rma:manage', 'refunds:create'] } },
        { path: 'admin/orders',     name: 'admin-orders',     component: OrdersAdminView,
          meta: { requiresPerm: ['orders:read'] } },
        { path: 'admin/reports',    name: 'admin-reports',    component: ReportsView,
          meta: { requiresPerm: ['reports:view', 'reports:cogs'] } },
        { path: 'admin/promotions', name: 'admin-promotions', component: PromotionsView,
          meta: { requiresPerm: ['promotions:manage'] } },
        { path: 'categories',       name: 'categories',       component: CategoriesView,
          meta: { requiresPerm: ['catalog:write'] } },
        { path: 'customers',        name: 'customers',        component: CustomersView,
          meta: { requiresPerm: ['customers:read'] } },
        { path: 'users',            name: 'users',            component: UsersView,
          meta: { requiresPerm: ['users:manage'] } },

        { path: '', redirect: () => homeFor() },
        { path: ':pathMatch(.*)*', redirect: () => homeFor() },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: () => homeFor() },
  ],
});

function homeFor() {
  const auth = useAuthStore();
  if (auth.hasPerm('orders:fulfill', 'orders:read')) return '/admin/orders';
  if (auth.isStaff()) return '/admin/inventory';
  return '/shop';
}

router.beforeEach((to) => {
  const auth = useAuthStore();

  if (to.meta.public) {
    if (auth.isLoggedIn()) return homeFor();
    return true;
  }
  if (!auth.isLoggedIn()) {
    return to.meta.guestOk ? true : '/login';
  }
  if (to.meta.requiresPerm && !auth.hasPerm(...to.meta.requiresPerm)) {
    return '/shop';
  }
  return true;
});

export default router;
