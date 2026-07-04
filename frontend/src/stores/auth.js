import { ref } from 'vue';
import { defineStore } from 'pinia';
import axios from 'axios';
import { setToken } from '@/services/api';

export const useAuthStore = defineStore('auth', () => {
    const user = ref(null);
    const accessToken = ref(null);

    function _setToken(token) {
        accessToken.value = token;
        setToken(token);
    }

    // Try to restore session from a refresh token cookie on app load
    async function init() {
        try {
            const res = await axios.post('/api/v1/auth/refresh', {}, { withCredentials: true });
            _setToken(res.data.accessToken);
            user.value = res.data.user;
        } catch (err) {
            if (import.meta.env.DEV) {
                console.warn('[auth] Session restore failed:', err?.response?.status, err?.response?.data ?? err?.message);
            }
            // No valid session — user will need to log in
        }
    }

    /**
     * Step 1 of login: request a one-time passcode be sent to the given email.
     * @param {string} email
     */
    async function requestOTP(email) {
        await axios.post('/api/v1/auth/request-otp', { email });
    }

    /**
     * Step 2 of login: submit the OTP and receive an access token.
     * @param {string} email
     * @param {string} otp
     */
    async function verifyOTP(email, otp) {
        const res = await axios.post('/api/v1/auth/verify-otp', { email, otp }, { withCredentials: true });
        _setToken(res.data.accessToken);
        user.value = res.data.user;
        return res.data;
    }

    /**
     * Customer self-registration. Requires a pre-issued invitation code.
     * On success the backend immediately sends an OTP — the caller should
     * present an OTP entry form rather than assuming the user is logged in.
     * @param {string} email
     * @param {string} invitationCode
     */
    async function register(email, invitationCode) {
        await axios.post('/api/v1/auth/register', { email, invitationCode });
    }

    async function logout() {
        try {
            await axios.post('/api/v1/auth/logout', {}, { withCredentials: true });
        } catch { /* ignore */ }
        _setToken(null);
        user.value = null;
    }

    const isLoggedIn = () => !!accessToken.value;
    const isAdmin    = () => user.value?.role === 'admin';

    /** Permission codes from the JWT perms claim (set at token mint time). */
    function perms() {
        try {
            const payload = JSON.parse(atob(accessToken.value.split('.')[1]));
            return Array.isArray(payload.perms) ? payload.perms : [];
        } catch {
            return [];
        }
    }
    const hasPerm = (...codes) => {
        const held = perms();
        return codes.some(c => held.includes(c));
    };
    /** Staff = holds any operational permission; customers hold none. */
    const isStaff = () => perms().length > 0;

    return { user, accessToken, init, requestOTP, verifyOTP, register, logout,
             isLoggedIn, isAdmin, isStaff, hasPerm, perms };
});
