document.querySelectorAll('.nav-auth a').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.nav-auth a').forEach((item) => item.classList.remove('selected'));
    link.classList.add('selected');
  });
});
