/**
 * Auth Login Interaction Script
 */

document.addEventListener('DOMContentLoaded', function () {
    const loginForm = document.querySelector('form');
    const passwordInput = document.getElementById('password');
    const togglePasswordBtn = document.getElementById('toggle-password');

    // Password Visibility Toggle
    if (togglePasswordBtn && passwordInput) {
        togglePasswordBtn.addEventListener('click', function () {
            const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
            passwordInput.setAttribute('type', type);
            // Toggle icon class if we had an icon library, for now we can toggle text or SVG
            // Assuming the button contains an SVG or icon
            this.classList.toggle('active');

            // Optional: Changes icon based on Bootstrap Icons if available
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

    // Basic Validation on Submit
    if (loginForm) {
        loginForm.addEventListener('submit', function (e) {
            let isValid = true;
            const email = document.getElementById('email');

            // Simple Email Check
            if (!email.value || !email.value.includes('@')) {
                isValid = false;
                email.classList.add('is-invalid');
            } else {
                email.classList.remove('is-invalid');
            }

            if (!isValid) {
                e.preventDefault();
            }
        });
    }
});
