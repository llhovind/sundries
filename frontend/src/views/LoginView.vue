<script setup>
import { ref, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

// Two-step state: 'email' or 'otp'
const step     = ref('email');
const email    = ref('');
const otp      = ref('');
const errorMsg = ref('');
const infoMsg  = ref('');
const loading  = ref(false);

async function submitEmail() {
    errorMsg.value = '';
    infoMsg.value  = '';
    if (!email.value) {
        errorMsg.value = 'Email is required.';
        return;
    }
    loading.value = true;
    try {
        await auth.requestOTP(email.value);
        infoMsg.value = 'A login code has been sent to your email.';
        step.value = 'otp';
        await nextTick();
        document.getElementById('otp')?.focus();
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Failed to send login code. Please try again.';
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

function backToEmail() {
    step.value     = 'otp';
    otp.value      = '';
    errorMsg.value = '';
    infoMsg.value  = '';
    step.value     = 'email';
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-card">
      <h2>Storefront</h2>

      <!-- Step 1: Email -->
      <template v-if="step === 'email'">
        <h3>Sign In</h3>
        <form @submit.prevent="submitEmail">
          <div class="field">
            <label for="email">Email address</label>
            <input id="email" v-model="email" type="email" autocomplete="email" autofocus />
          </div>
          <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
          <button type="submit" :disabled="loading">{{ loading ? 'Sending code…' : 'Send Login Code' }}</button>
        </form>
        <p class="switch">
          New customer? <router-link to="/register">Register</router-link>
        </p>
      </template>

      <!-- Step 2: OTP -->
      <template v-else>
        <h3>Enter Login Code</h3>
        <p class="info">{{ infoMsg }}</p>
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
        <p class="switch">
          <a href="#" @click.prevent="backToEmail">Use a different email</a>
        </p>
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

    // Large centred display for OTP digits
    &#otp {
      font-size: 1.6rem;
      letter-spacing: 0.4em;
      text-align: center;
    }
  }
}

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
  a { color: #5a3e8a; cursor: pointer; }
}
</style>
