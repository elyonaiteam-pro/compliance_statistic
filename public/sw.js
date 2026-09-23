self.addEventListener("push", (event) => {
  let data = { title: "Обновление по закупке", body: "" };
  try {
    data = event.data.json();
  } catch (e) {
    // ignore, use defaults
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
