// router.js - Shared Deep-Link Router for Starlink Apps

const Router = {
    // Parse the URL hash (e.g., #m=tx&f=type:capital)
    parseHash: function() {
        const hash = window.location.hash.substring(1); // remove the #
        if (!hash) return null;

        const params = new URLSearchParams(hash);
        const route = {};

        if (params.has('m')) route.module = params.get('m');
        if (params.has('f')) {
            route.filters = {};
            // Split by comma in case there are multiple filters
            params.get('f').split(',').forEach(f => {
                const [key, val] = f.split(':');
                route.filters[key] = val;
            });
        }
        return route;
    },

    // Set up the back button logic
    initBackButton: function(btnId) {
        const backBtn = document.getElementById(btnId);
        if (!backBtn) return;

        const urlParams = new URLSearchParams(window.location.search);
        const fromPage = urlParams.get('from');

        if (fromPage) {
            backBtn.style.display = 'inline-flex'; // Show it
            backBtn.href = fromPage;
        } else {
            backBtn.style.display = 'none'; // Hide it if no 'from' parameter exists
        }
    }
};
