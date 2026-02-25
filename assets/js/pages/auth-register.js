/**
 * Auth Register Interaction Script
 */

document.addEventListener('DOMContentLoaded', function () {
    const registerForm = document.querySelector('form');
    const passwordInput = document.getElementById('password');
    const confirmPasswordInput = document.getElementById('confirm-password');

    // Helper to setup toggle for an input
    function setupToggle(btnId, inputId) {
        const btn = document.getElementById(btnId);
        const input = document.getElementById(inputId);
        if (btn && input) {
            btn.addEventListener('click', function () {
                const type = input.getAttribute('type') === 'password' ? 'text' : 'password';
                input.setAttribute('type', type);

                const icon = this.querySelector('i');
                if (icon) {
                    if (type === 'text') {
                        icon.classList.remove('bi-eye');
                        icon.classList.add('bi-eye-slash');
                    } else {
                        icon.classList.remove('bi-eye-slash');
                        icon.classList.add('bi-eye');
                    }
                }
            });
        }
    }

    setupToggle('toggle-password', 'password');
    setupToggle('toggle-confirm-password', 'confirm-password');

    // Validation
    if (registerForm) {
        registerForm.addEventListener('submit', function (e) {
            let isValid = true;

            // Password Match Check
            if (passwordInput.value !== confirmPasswordInput.value) {
                isValid = false;
                confirmPasswordInput.classList.add('is-invalid');
                // You might want to show a message here
            } else {
                confirmPasswordInput.classList.remove('is-invalid');
            }

            if (!isValid) {
                e.preventDefault();
            }
        });
    }
});
