import math

from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response


class StandardPagination(PageNumberPagination):
    page_size = 25
    page_size_query_param = "page_size"
    max_page_size = 200

    def get_paginated_response(self, data):
        count = self.page.paginator.count
        size = self.get_page_size(self.request) or self.page_size
        return Response(
            {
                "results": data,
                "count": count,
                "page": self.page.number,
                "page_size": size,
                "total_pages": max(1, math.ceil(count / size)) if size else 1,
            }
        )
