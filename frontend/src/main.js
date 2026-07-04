import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { useAuthStore } from '@/stores/auth'
import { useCartStore } from '@/stores/cart'         // imported to register the store early
import { setOnRefreshFailed } from '@/services/api'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)

// Restore session before installing the router.
// Vue Router triggers the initial navigation immediately on app.use(router),
// which runs the beforeEach guard. If the router were installed before init()
// resolves, the guard would see isLoggedIn()=false and redirect to /login even
// when a valid refresh token exists.
const auth = useAuthStore()
setOnRefreshFailed(() => {
    auth.user = null
    auth.accessToken = null
    router.push('/login')
})

auth.init().finally(() => {
    // Registering the cart store here ensures its watchAuthUser fires during
    // auth.init(), so the cart is hydrated before the first route renders.
    useCartStore();

    app.use(router)   // install router after auth state is known
    app.mount('#app')
})
