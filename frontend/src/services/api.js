import axios from 'axios';

// Internal token store — set by auth store via setToken()
let _accessToken = null;
let _onRefreshFailed = () => { window.location.href = '/login'; };

export function setToken(token) {
    _accessToken = token;
}

export function setOnRefreshFailed(fn) {
    _onRefreshFailed = fn;
}

const api = axios.create({ withCredentials: true });

// Attach access token to every request
api.interceptors.request.use(config => {
    if (_accessToken) {
        config.headers['Authorization'] = `Bearer ${_accessToken}`;
    }
    return config;
});

// On 401: try one silent refresh, then give up
let _refreshPromise = null;

api.interceptors.response.use(
    res => res,
    async err => {
        // Normalize error message: protected routes wrap it in outcome.message,
        // auth routes return it as data.message directly. Flatten to data.message.
        if (err.response?.data?.outcome?.message) {
            err.response.data.message = err.response.data.outcome.message;
        }

        const original = err.config;
        if (err.response?.status === 401 && !original._retry) {
            original._retry = true;

            if (!_refreshPromise) {
                _refreshPromise = axios
                    .post('/api/v1/auth/refresh', {}, { withCredentials: true })
                    .then(res => {
                        _accessToken = res.data.accessToken;
                        return res.data;
                    })
                    .finally(() => { _refreshPromise = null; });
            }

            try {
                await _refreshPromise;
                original.headers['Authorization'] = `Bearer ${_accessToken}`;
                return api(original);
            } catch {
                _accessToken = null;
                _onRefreshFailed();
                return Promise.reject(err);
            }
        }
        return Promise.reject(err);
    }
);

export default api;
