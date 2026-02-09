    <section class="paginationWrapper container d-flex justify-content-between align-items-center mb-5">
      <div class="paginationControls">
        <label for="itemsPerPage" class="me-2">Inserate pro Seite:</label>
        <select id="itemsPerPage" class="form-select w-auto" style="width: 80px !important;"
          onchange="window.location.search='hp=1&limit='+this.value+'<%= baseQS %>'">
          <option value="30" <%=limit===30 ? 'selected' :'' %>>30</option>
          <option value="60" <%=limit===60 ? 'selected' :'' %>>60</option>
          <option value="120" <%=limit===120?'selected':'' %>>120</option>
        </select>
      </div>


     <div id="pagination" class="pagination"></div>

    </section>