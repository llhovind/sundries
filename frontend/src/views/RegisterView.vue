<script setup>
import { ref, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

// Two-step state: 'form' (email + invitation code) or 'otp'
const step           = ref('form');
const email          = ref('');
const invitationCode = ref('');
const otp            = ref('');
const errorMsg       = ref('');
const loading        = ref(false);

async function submitRegistration() {
    errorMsg.value = '';
    if (!email.value || !invitationCode.value) {
        errorMsg.value = 'Email and invitation code are required.';
        return;
    }
    loading.value = true;
    try {
        await auth.register(email.value, invitationCode.value);
        // Backend created the account and sent an OTP — move to verification step
        step.value = 'otp';
        await nextTick();
        document.getElementById('otp')?.focus();
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Registration failed. Please try again.';
    } finally {
        loading.value = false;
    }
}

async function submitOTP() {
    errorMsg.value = '';
    if (!otp.value) {
        errorMsg.value = 'Please enter the login code.';
        return;
    }
    loading.value = true;
    try {
        const data = await auth.verifyOTP(email.value, otp.value);
        router.push(data.user.role === 'admin' ? '/inventory' : '/shop');
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Invalid or expired code. Please try again.';
    } finally {
        loading.value = false;
    }
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-card">
      <h2>Storefront</h2>

      <!-- Step 1: Email + invitation code -->
      <template v-if="step === 'form'">
        <h3>Create Account</h3>
        <form @submit.prevent="submitRegistration">
          <div class="field">
            <label for="email">Email address <span class="req">*</span></label>
            <input id="email" v-model="email" type="email" autocomplete="email" autofocus />
          </div>
          <div class="field">
            <label for="invitationCode">Invitation code <span class="req">*</span></label>
            <input id="invitationCode" v-model="invitationCode" type="text" autocomplete="off" />
          </div>
          <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
          <button type="submit" :disabled="loading">{{ loading ? 'Registering…' : 'Register' }}</button>
        </form>
        <p class="switch">
          Already have an account? <router-link to="/login">Sign in</router-link>
        </p>
      </template>

      <!-- Step 2: OTP sent after registration -->
      <template v-else>
        <h3>Check Your Email</h3>
        <p class="info">
          Your account has been created. A login code was sent to <strong>{{ email }}</strong>.
        </p>
        <form @submit.prevent="submitOTP">
          <div class="field">
            <label for="otp">6-digit code</label>
            <input
              id="otp"
              v-model="otp"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              placeholder="______"
            />
          </div>
          <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
          <button type="submit" :disabled="loading">{{ loading ? 'Verifying…' : 'Sign In' }}</button>
        </form>
      </template>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.auth-page {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 80vh;
  grid-column: 1 / -1;
}

.auth-card {
  background: #fff;
  border: #8090BF solid 2px;
  border-radius: 8px;
  padding: 2rem 2.5rem;
  min-width: 320px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.12);

  h2 {
    margin: 0 0 0.25rem;
    color: #5a3e8a;
    font-size: 1.4rem;
    text-align: center;
  }

  h3 {
    margin: 0 0 1rem;
    color: #666;
    font-size: 1rem;
    font-weight: normal;
    text-align: center;
  }
}

.info {
  font-size: 0.875rem;
  color: #2e7d32;
  background: #f1f8f1;
  border: 1px solid #c8e6c9;
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
  text-align: center;
  line-height: 1.5;
}

.field {
  display: flex;
  flex-direction: column;
  margin-bottom: 1rem;

  label {
    font-size: 0.85rem;
    margin-bottom: 0.3rem;
    color: #444;
  }

  input {
    padding: 0.5rem 0.75rem;
    border: 1px solid #bbb;
    border-radius: 4px;
    font-size: 1rem;
    &:focus {
      outline: none;
      border-color: #8090BF;
      box-shadow: 0 0 0 2px rgba(128,144,191,0.25);
    }

    &#otp {
      font-size: 1.6rem;
      letter-spacing: 0.4em;
      text-align: center;
    }
  }
}

.req { color: #c0392b; font-size: 0.8rem; }

.error {
  color: #c0392b;
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}

button {
  width: 100%;
  padding: 0.6rem;
  background: #5a3e8a;
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  &:disabled { opacity: 0.6; cursor: not-allowed; }
  &:hover:not(:disabled) { background: #7a5ea8; }
}

.switch {
  text-align: center;
  margin-top: 1rem;
  font-size: 0.9rem;
  color: #666;
  a { color: #5a3e8a; }
}
</style>
