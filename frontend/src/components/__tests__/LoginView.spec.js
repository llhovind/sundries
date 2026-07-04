import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LoginView from '@/views/LoginView.vue';
import { useAuthStore } from '@/stores/auth';

// Router is used for post-login navigation; stub it.
const pushMock = vi.fn();
vi.mock('vue-router', () => ({
    useRouter: () => ({ push: pushMock }),
    useRoute:  () => ({ query: {} }),
}));

describe('LoginView (passwordless OTP flow)', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        pushMock.mockClear();
    });

    it('given first load then the email step renders', () => {
        const wrapper = shallowMount(LoginView);
        expect(wrapper.find('#email').exists()).toBe(true);
        expect(wrapper.find('#otp').exists()).toBe(false);
        expect(wrapper.text()).toContain('Send Login Code');
    });

    it('given a submitted email then requestOTP is called and the OTP step shows', async () => {
        const auth = useAuthStore();
        auth.requestOTP = vi.fn().mockResolvedValue();

        const wrapper = shallowMount(LoginView);
        await wrapper.find('#email').setValue('shopper@example.com');
        await wrapper.find('form').trigger('submit');
        await new Promise(r => setTimeout(r));

        expect(auth.requestOTP).toHaveBeenCalledWith('shopper@example.com');
        expect(wrapper.find('#otp').exists()).toBe(true);
    });

    it('given a submitted code then verifyOTP is called with email and code', async () => {
        const auth = useAuthStore();
        auth.requestOTP = vi.fn().mockResolvedValue();
        auth.verifyOTP  = vi.fn().mockResolvedValue({ user: { role: 'customer' } });

        const wrapper = shallowMount(LoginView);
        await wrapper.find('#email').setValue('shopper@example.com');
        await wrapper.find('form').trigger('submit');
        await new Promise(r => setTimeout(r));

        await wrapper.find('#otp').setValue('123456');
        await wrapper.find('form').trigger('submit');
        await new Promise(r => setTimeout(r));

        expect(auth.verifyOTP).toHaveBeenCalledWith('shopper@example.com', '123456');
    });

    it('given a failed OTP request then the error is shown and the step stays', async () => {
        const auth = useAuthStore();
        auth.requestOTP = vi.fn().mockRejectedValue({ response: { data: { message: 'Too many attempts' } } });

        const wrapper = shallowMount(LoginView);
        await wrapper.find('#email').setValue('shopper@example.com');
        await wrapper.find('form').trigger('submit');
        await new Promise(r => setTimeout(r));

        expect(wrapper.find('#email').exists()).toBe(true);
        expect(wrapper.text()).toContain('Too many attempts');
    });
});
