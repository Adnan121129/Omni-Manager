from django.urls import include, path

urlpatterns = [
    path("api/", include("config.api_urls")),
]
