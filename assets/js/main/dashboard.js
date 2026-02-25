/**
 * Dashboard Interaction Script
 */

document.addEventListener('DOMContentLoaded', function () {
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.querySelector('.sidebar-overlay');
    const burgerBtn = document.querySelector('.burger-btn');
    const body = document.body;

    const sidebarCloseBtn = document.getElementById('sidebar-close');

    // Perfect Scrollbar - Simplified with strict boundaries
    let ps;
    const container = document.querySelector(".sidebar-menu");

    if (container && typeof PerfectScrollbar !== 'undefined') {
        ps = new PerfectScrollbar(container, {
            wheelPropagation: false,
            suppressScrollX: true
        });
    }

    // Helper to update and enforce scroll boundaries
    const updatePS = (delay = 0) => {
        if (!ps || !container) return;
        setTimeout(() => {
            ps.update();
            // Force scroll to stay within valid bounds
            const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
            if (container.scrollTop > maxScroll) {
                container.scrollTop = maxScroll;
                ps.update();
            }
        }, delay);
    }

    // Toggle Sidebar Function
    function toggleSidebar() {
        if (window.innerWidth < 992) {
            sidebar.classList.toggle('active');
            if (sidebarOverlay) sidebarOverlay.classList.toggle('active');
        } else {
            body.classList.toggle('sidebar-collapsed');
            updatePS(300);
        }
    }

    // Close Sidebar (Mobile)
    function closeSidebar() {
        if (window.innerWidth < 992) {
            sidebar.classList.remove('active');
            if (sidebarOverlay) sidebarOverlay.classList.remove('active');
        }
    }

    // Event Listeners
    if (burgerBtn) {
        burgerBtn.addEventListener('click', function (e) {
            e.preventDefault();
            toggleSidebar();
        });
    }

    if (sidebarCloseBtn) {
        sidebarCloseBtn.addEventListener('click', function (e) {
            e.preventDefault();
            closeSidebar();
        });
    }

    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', function () {
            sidebar.classList.remove('active');
            sidebarOverlay.classList.remove('active');
        });
    }

    // Submenu Toggle - Clean Implementation
    const submenuLinks = document.querySelectorAll('.sidebar-item.has-sub > .sidebar-link');

    submenuLinks.forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            const parent = this.closest('.sidebar-item');
            const isActive = parent.classList.contains('active');

            // Expand sidebar if collapsed
            if (body.classList.contains('sidebar-collapsed')) {
                body.classList.remove('sidebar-collapsed');
                updatePS(300);
            }

            // Accordion: Close other submenus when opening a new one
            if (!isActive) {
                document.querySelectorAll('.sidebar-item.has-sub.active').forEach(item => {
                    if (item !== parent) {
                        item.classList.remove('active');
                    }
                });
                parent.classList.add('active');
            } else {
                parent.classList.remove('active');
            }

            // Update scrollbar after animation
            updatePS(50);
            updatePS(350);
        });
    });

    // Handle Window Resize
    window.addEventListener('resize', function () {
        if (window.innerWidth >= 992) {
            sidebar.classList.remove('active');
            if (sidebarOverlay) sidebarOverlay.classList.remove('active');
        }
        updatePS(100);
    });
});
